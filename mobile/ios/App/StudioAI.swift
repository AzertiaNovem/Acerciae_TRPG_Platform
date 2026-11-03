import SwiftUI
import Security
import AcerciaeCore

struct StudioAIConfig: Codable, Equatable {
    var provider = "openai"
    var endpoint = ""
    var model = ""
    var key = ""
    var publicValue: JSONValue { .object(["provider":.string(provider),"endpoint":.string(endpoint),"model":.string(model)]) }
    func url() throws -> URL {
        guard ["openai","anthropic"].contains(provider), !model.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
              !key.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
              let parts = URLComponents(string:endpoint), parts.scheme == "https", parts.host?.isEmpty == false,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              let base = parts.url else { throw StudioAIError.message("Enter an HTTPS service address, model and API key") }
        return base.appendingPathComponent(provider == "anthropic" ? "messages" : "chat/completions")
    }
}
enum StudioAIError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
enum StudioAISecrets {
    private static var query: [String:Any] { [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"app.acerciae.mobile.studio-ai",kSecAttrAccount as String:"provider"] }
    static func read() throws -> StudioAIConfig {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary,&item)
        if status == errSecItemNotFound { return StudioAIConfig() }
        guard status == errSecSuccess, let data = item as? Data else { throw SessionStore.StoreError.unavailable }
        return try JSONDecoder().decode(StudioAIConfig.self,from:data)
    }
    static func save(_ config: StudioAIConfig) throws {
        _ = try config.url()
        let values: [String:Any] = [kSecValueData as String:try JSONEncoder().encode(config),kSecAttrAccessible as String:kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary,values as CFDictionary)
        if status == errSecItemNotFound { guard SecItemAdd(query.merging(values){_,new in new} as CFDictionary,nil) == errSecSuccess else { throw SessionStore.StoreError.unavailable } }
        else if status != errSecSuccess { throw SessionStore.StoreError.unavailable }
    }
    static func clear() throws { let status = SecItemDelete(query as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { throw SessionStore.StoreError.unavailable } }
}
final class StudioAITransport: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void) { completionHandler(nil) }
    func send(_ body: JSONValue, config: StudioAIConfig, session injected: URLSession? = nil) async throws -> JSONValue {
        var request = URLRequest(url:try config.url()); request.httpMethod = "POST"; request.timeoutInterval = 300
        request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        if config.provider == "anthropic" { request.setValue(config.key,forHTTPHeaderField:"x-api-key"); request.setValue("2023-06-01",forHTTPHeaderField:"anthropic-version") }
        else { request.setValue("Bearer " + config.key,forHTTPHeaderField:"Authorization") }
        request.httpBody = try JSONEncoder().encode(body)
        let settings = URLSessionConfiguration.ephemeral; settings.httpCookieStorage = nil; settings.urlCache = nil; settings.timeoutIntervalForResource = 300
        let session = injected ?? URLSession(configuration:settings,delegate:self,delegateQueue:nil)
        defer { if injected == nil { session.invalidateAndCancel() } }
        let (bytes,response) = try await session.bytes(for:request)
        guard let http = response as? HTTPURLResponse else { throw StudioAIError.message("Invalid AI response") }
        var data = Data(); for try await byte in bytes { data.append(byte); if data.count > 8 * 1024 * 1024 { throw StudioAIError.message("AI response is too large") } }
        let value = (try? JSONDecoder().decode(JSONValue.self,from:data)) ?? .null
        return .object(["status":.number(Double(http.statusCode)),"body":value])
    }
}
extension LocalStudioModel {
    func startAI(_ mode: String) {
        guard !busy, aiTask == nil else { return }
        aiTask = Task {
            defer { aiTask = nil }
            await flush()
            await perform {
                let parts = project["vn_draft"]["pending"].array
                let offline = mode == "resume" && !parts.isEmpty && parts.allSatisfy { $0["skip"].bool }
                let config = offline ? StudioAIConfig(model:"offline") : try StudioAISecrets.read()
                if !offline { _ = try config.url() }
                aiRunning = true; defer { aiRunning = false; aiTask = nil; aiProgress = "" }
                engine = LocalStudioEngine()
                var id = ""
                do {
                    var state = try await engine.call(.object(["action":.string("aiStart"),"mode":.string(mode),"project":project,"config":config.publicValue,"language":.string(MobileLocale.shared.language),"instructions":project["mobile_ai_instructions"]]))
                    id = state["id"].text
                    while true {
                        try Task.checkCancellation()
                        if state["state"].text == "done" { project = state["project"]; try await store.save(project); await reload(); break }
                        var fields = project.object; fields["mobile_ai_job"] = state["checkpoint"]; project = .object(fields)
                        try await store.save(project)
                        aiProgress = "\(state["done"].int) / \(state["total"].int)"
                        if state["state"].text == "failed" { throw StudioAIError.message(state["error"].text) }
                        if state["request"] != .null {
                            let response = try await StudioAITransport().send(state["request"]["body"],config:config)
                            state = try await engine.call(.object(["action":.string("aiAnswer"),"id":.string(id),"response":response]))
                        } else {
                            try await Task.sleep(for:.milliseconds(50))
                            state = try await engine.call(.object(["action":.string("aiPoll"),"id":.string(id)]))
                        }
                    }
                } catch {
                    // Cancel the isolated runtime job even when this Swift task itself was cancelled.
                    if !id.isEmpty { let engine = self.engine; let task = Task { @MainActor in _ = try? await engine.call(.object(["action":.string("aiCancel"),"id":.string(id)])) }; await task.value }
                    if Task.isCancelled { return }; throw error
                }
            }
        }
    }
    func pauseAI() { aiTask?.cancel() }
    func discardAI(_ key: String) { var fields = project.object; fields.removeValue(forKey:key); project = .object(fields); Task { await flush() } }
    func answerAI(_ index: Int, question: String?, value: String = "", skip: Bool? = nil) {
        var draft = project["vn_draft"].object; var rows = project["vn_draft"]["pending"].array
        guard rows.indices.contains(index) else { return }; var row = rows[index].object
        if let question { var answers = rows[index]["answers"].object; answers[question] = .string(String(value.prefix(2000))); row["answers"] = .object(answers) }
        if let skip { row["skip"] = .bool(skip) }
        rows[index] = .object(row); draft["pending"] = .array(rows); set("vn_draft",.object(draft))
    }
}
struct StudioAIEditor: View {
    @ObservedObject var model: LocalStudioModel
    @State private var config = StudioAIConfig()
    @State private var saved = false
    @State private var recompose = false
    @State private var reviewLimit = 40
    private func begin(_ mode: String) {
        do {
            if !(mode == "resume" && !pending.isEmpty && pending.allSatisfy { $0["skip"].bool }) { try StudioAISecrets.save(config); saved = true }
            model.startAI(mode)
        } catch { model.error = tr(error.localizedDescription) }
    }
    private var pending: [JSONValue] { model.project["vn_draft"]["pending"].array }
    private func pendingPart(_ index: Int) -> JSONValue { pending.indices.contains(index) ? pending[index] : .null }
    private var hasNewLines: Bool { let last = model.project["vn"]["script"]["scenes"].array.flatMap { $0["lines"].array }.map { $0["seq"].int }.max() ?? 0; return model.project["events"].array.contains { $0["seq"].int > last } }
    private var canResume: Bool { !pending.isEmpty && pending.allSatisfy { $0["skip"].bool || $0["answers"].object.values.contains { !$0.text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty } } }
    private func context(_ ref: String) -> String {
        let from = model.project["vn_draft"]["from_seq"].int
        let events = model.project["events"].array.filter { $0["seq"].int > from }
        guard let index = Int(ref.dropFirst()), index > 0, index <= events.count else { return ref }
        return ref + " · " + events[index-1]["speaker_name"].text + ": " + events[index-1]["content"].text
    }
    private var changes: [JSONValue] {
        model.project["vn"]["script"]["scenes"].array.flatMap { $0["lines"].array }.filter { $0["hidden"].bool || !$0["text"].text.isEmpty }
    }
    var body: some View {
        Section(tr("AI script editor")) {
            DisclosureGroup(tr("AI service")) {
                Picker(tr("Provider"),selection:$config.provider) { Text("OpenAI compatible").tag("openai"); Text("Anthropic").tag("anthropic") }
                TextField(tr("Service address"),text:$config.endpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                TextField(tr("Model"),text:$config.model).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("API key",text:$config.key).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button(tr("Save")) { do { try StudioAISecrets.save(config); saved = true } catch { model.error = tr(error.localizedDescription) } }
                Button(tr("Remove saved AI key"),role:.destructive) { do { try StudioAISecrets.clear(); config = StudioAIConfig(); saved = false } catch { model.error = tr(error.localizedDescription) } }
                if saved { Text(tr("Saved")) }
            }
            Text(tr("AI receives this project's logs and character context. Keys stay on this device and are excluded from backups.")).font(.caption).foregroundStyle(.secondary)
            TextField(tr("Editing directions"),text:Binding(get:{model.project["mobile_ai_instructions"].text},set:{model.set("mobile_ai_instructions",.string($0))}),axis:.vertical)
            if model.project["mobile_ai_job"] != .null {
                Button(tr("Resume unfinished task")) { begin("retry") }
                Button(tr("Discard unfinished task"),role:.destructive) { model.discardAI("mobile_ai_job") }
            } else if !pending.isEmpty {
                ForEach(Array(pending.enumerated()),id:\.offset) { index,part in
                    VStack(alignment:.leading,spacing:10) {
                        Text("L\(part["first_line"].int)–L\(part["last_line"].int)").font(.headline)
                        ForEach(Array(part["questions"].array.enumerated()),id:\.offset) { _,question in
                            Text(question["question"].text)
                            ForEach(question["refs"].array.map(\.text),id:\.self) { ref in Text(context(ref)).font(.caption).foregroundStyle(.secondary) }
                            ForEach(question["options"].array.map(\.text),id:\.self) { option in Button(option) { model.answerAI(index,question:question["id"].text,value:option) } }
                            TextField(tr("Your answer"),text:Binding(get:{pendingPart(index)["answers"][question["id"].text].text},set:{model.answerAI(index,question:question["id"].text,value:$0)}),axis:.vertical)
                        }
                        Toggle(tr("Keep this part's draft"),isOn:Binding(get:{pendingPart(index)["skip"].bool},set:{model.answerAI(index,question:nil,skip:$0)}))
                    }
                }
                Button(tr("Submit answers and continue")) { begin("resume") }.disabled(!canResume)
                Button(tr("Discard questions"),role:.destructive) { model.discardAI("vn_draft") }
            } else {
                Button(tr("Compose / rewrite with AI")) { if model.project["vn"] == .null { begin("compose") } else { recompose = true } }
                if model.project["vn"] != .null { Button(tr("Continue from added logs")) { begin("continue") }.disabled(!hasNewLines) }
            }
            Text(tr("Backgrounding pauses AI work. Resume it here; saved responses are reused.")).font(.caption).foregroundStyle(.secondary)
            if !changes.isEmpty { DisclosureGroup(tr("Rewrites and exclusions")) {
                ForEach(Array(changes.prefix(reviewLimit).enumerated()),id:\.offset) { _,line in
                    let original = model.project["events"].array.first { $0["seq"].int == line["seq"].int }
                    VStack(alignment:.leading,spacing:5) { Text("#\(line["seq"].int) · " + (original?["content"].text ?? "")).foregroundStyle(.secondary); Text(line["hidden"].bool ? line["exclusion_reason"].text : line["text"].text) }.font(.caption)
                }
                if changes.count > reviewLimit { Button(tr("Show more")) { reviewLimit += 40 } }
            } }
            ForEach(Array(model.project["vn"]["script"]["notes"].array.enumerated()),id:\.offset) { _,note in Text(note.text).font(.caption).foregroundStyle(.secondary) }
        }
        .onChange(of:config) { _,_ in saved = false }
        .task { do { config = try StudioAISecrets.read() } catch { model.error = tr(error.localizedDescription) } }
        .confirmationDialog(tr("Replace the existing script?"),isPresented:$recompose) { Button(tr("Compose / rewrite with AI")) { begin("compose") } } message: { Text(tr("The original logs stay unchanged. The existing script is kept until generation succeeds.")) }
    }
}
