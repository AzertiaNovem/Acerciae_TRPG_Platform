import SwiftUI
import WebKit
import ImageIO
import UniformTypeIdentifiers
import AcerciaeCore

@MainActor final class LocalStudioEngine: NSObject, WKNavigationDelegate {
    private let web = WKWebView(frame:.zero,configuration:{ let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent(); return configuration }())
    private var ready = false
    private var failure: Error?
    private var waiting: [CheckedContinuation<Void,Error>] = []
    override init() {
        super.init(); web.navigationDelegate = self
        guard let url = Bundle.main.url(forResource:"studio-engine",withExtension:"html") else { failure = LocalStudioError.invalidFile; return }
        web.loadFileURL(url,allowingReadAccessTo:url.deletingLastPathComponent())
        Task { [weak self] in try? await Task.sleep(for:.seconds(30)); guard let self, !self.ready else { return }; self.fail(URLError(.timedOut)) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true; failure = nil; waiting.forEach { $0.resume() }; waiting = [] }
    private func fail(_ error: Error) { failure = error; ready = false; waiting.forEach { $0.resume(throwing:error) }; waiting = [] }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail(URLError(.cannotLoadFromNetwork)) }
    func call(_ payload: JSONValue) async throws -> JSONValue {
        if let failure { throw failure }
        if !ready { try await withCheckedThrowingContinuation { waiting.append($0) } }
        try Task.checkCancellation()
        let json = String(data:try JSONEncoder().encode(payload),encoding:.utf8)!
        let result = try await web.callAsyncJavaScript("return await MobileStudio.run(payload)",arguments:["payload":json],in:nil,contentWorld:.page)
        guard let text = result as? String, let data = text.data(using:.utf8) else { throw LocalStudioError.invalidFile }
        let value = try JSONDecoder().decode(JSONValue.self,from:data)
        guard value["ok"].bool else { throw NSError(domain:"LocalStudio",code:1,userInfo:[NSLocalizedDescriptionKey:value["error"].text]) }
        return value["value"]
    }
}
@MainActor final class LocalStudioModel: ObservableObject {
    @Published var projects: [JSONValue] = []
    @Published var project: JSONValue = .null
    @Published var busy = false
    @Published var error: String?
    @Published var document: StudioDocument?
    @Published var aiRunning = false
    @Published var aiProgress = ""
    var aiTask: Task<Void,Never>?
    let store = LocalStudioStore(root:FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("OpenLogStudio/projects"))
    var engine = LocalStudioEngine()
    private var pending: Task<Void,Never>?
    func perform(_ action: () async throws -> Void) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { try await action() } catch is CancellationError {} catch { self.error = tr(error.localizedDescription) }
    }
    func reload() async { do { projects = try await store.list() } catch { self.error = tr(error.localizedDescription) } }
    func open(_ id: String) async { await flush(); await perform { project = try await store.load(id) } }
    func set(_ key: String, _ value: JSONValue) { var obj = project.object; obj[key] = value; if key == "title" { var background = project["background"].object; background["title"] = value; obj["background"] = .object(background) }; project = .object(obj); changed() }
    func background(_ key: String, _ value: String) { var obj = project["background"].object; obj[key] = .string(value); set("background",.object(obj)) }
    func character(_ index: Int, _ key: String, _ value: JSONValue) { var rows = project["characters"].array; guard rows.indices.contains(index) else { return }; var row = rows[index].object; row[key] = value; rows[index] = .object(row); set("characters",.array(rows)) }
    private func changed() {
        pending?.cancel(); pending = Task { do { try await Task.sleep(for:.milliseconds(500)); try await store.save(project) } catch is CancellationError {} catch { self.error = tr(error.localizedDescription) } }
    }
    func flush() async { pending?.cancel(); guard project != .null else { return }; do { try await store.save(project) } catch { self.error = tr(error.localizedDescription) } }
    func importFiles(_ urls: [URL], append: Bool) async {
        await flush()
        await perform {
            let files: [JSONValue] = try await Task.detached {
                var total = 0
                return try urls.map { url in
                    let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0
                    guard size <= 32 * 1024 * 1024 else { throw LocalStudioError.invalidFile }
                    let file = try FileHandle(forReadingFrom:url); defer { try? file.close() }
                    let data = try file.read(upToCount:32 * 1024 * 1024 + 1) ?? Data(); total += data.count
                    guard total <= 32 * 1024 * 1024 else { throw LocalStudioError.invalidFile }
                    return .object(["name":.string(url.lastPathComponent),"data":.string(data.base64EncodedString())])
                }
            }.value
            var input: [String:JSONValue] = ["action":.string("import"),"files":.array(files)]
            if append { input["project"] = project }
            let result = try await engine.call(.object(input)); let next = result["project"]
            try await store.addAssets(next["id"].text,result["assets"]); try await store.save(next)
            project = next; await reload()
        }
    }
    func picture(_ url: URL, index: Int?, slot: String) async {
        await perform {
            let encoded: Data = try await Task.detached {
                let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                guard (try url.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0) <= 10 * 1024 * 1024,
                      let source = CGImageSourceCreateWithURL(url as CFURL,nil), let thumbnail = CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:1920,kCGImageSourceCreateThumbnailWithTransform:true] as CFDictionary), let data = UIImage(cgImage:thumbnail).jpegData(compressionQuality:0.8), data.count <= 10 * 1024 * 1024 else { throw LocalStudioError.invalidFile }
                return data
            }.value
            let previous = index.map { project["characters"].array[$0][slot].text } ?? project["mobile_background"].text
            let path = "assets/" + UUID().uuidString + ".jpg"
            try await store.addAssets(project["id"].text,.object([path:.string("data:image/jpeg;base64," + encoded.base64EncodedString())]))
            if let index { character(index,slot,.string(path)) } else { set("mobile_background",.string(path)) }
            pending?.cancel(); try await store.save(project)
            try await store.removeUnusedAsset(project["id"].text,previous,project:project)
        }
    }
    func export(_ action: String, ooc: Bool, secret: Bool) async {
        await flush()
        await perform {
            let result = try await engine.call(.object(["action":.string(action),"project":project,"assets":try await store.assets(project["id"].text),"ooc":.bool(ooc),"secret":.bool(secret),"language":.string(MobileLocale.shared.language)]))
            let html = result["html"].string
            let ext = html == nil ? result["ext"].text : "html"
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Studio-" + UUID().uuidString)
            try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
            let url = dir.appendingPathComponent("OpenLogStudio." + ext)
            try (html ?? result["text"].text).write(to:url,atomically:true,encoding:.utf8)
            document = StudioDocument(url:url,title:project["title"].text,kind:action)
        }
    }
}
struct StudioDocument: Identifiable { let id = UUID(); let url: URL; let title: String; let kind: String }
struct LocalStudioView: View {
    @StateObject private var model = LocalStudioModel()
    @State private var importing = false
    @State private var deleting: JSONValue?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    var body: some View {
        NavigationStack {
            Group {
                if model.project != .null { LocalStudioEditor(model:model) }
                else { List {
                    Section { Text(tr("Local projects stay on this device, including after sign-out.")).font(.footnote).foregroundStyle(.secondary)
                        Button(tr("Import logs")) { importing = true }.disabled(model.busy)
                    }
                    if model.projects.isEmpty { Text(tr("No local projects yet")) }
                    ForEach(Array(model.projects.enumerated()),id:\.offset) { _, row in
                        Button { Task { await model.open(row["id"].text) } } label: {
                            VStack(alignment:.leading,spacing:5) { Text(row["title"].text); Text("\(row["events"].int) · " + tr("Lines")).font(.caption).foregroundStyle(.secondary) }
                        }.swipeActions { Button(tr("Delete"),role:.destructive) { deleting = row } }
                    }
                } }
            }
            .navigationTitle(model.project == .null ? tr("Open Log Studio") : model.project["title"].text)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement:.topBarLeading) { if model.project != .null { Button(tr("Projects")) { Task { await model.flush(); model.project = .null; await model.reload() } }.disabled(model.busy) } }
                ToolbarItem(placement:.confirmationAction) { Button(tr("完成")) { Task { await model.flush(); dismiss() } }.disabled(model.busy) }
            }
            .overlay { if model.busy { VStack { ProgressView(); if model.aiRunning { Text(model.aiProgress); Button(tr("Pause")) { model.pauseAI() } } }.padding(20).background(.regularMaterial,in:RoundedRectangle(cornerRadius:12)) } }
            .task { await model.reload() }
            .onChange(of:phase) { _, value in if value == .background { model.pauseAI(); Task { await model.flush() } } }
            .fileImporter(isPresented:$importing,allowedContentTypes:[.json,.plainText,.data],allowsMultipleSelection:true) { result in
                switch result { case .success(let urls): Task { await model.importFiles(urls,append:false) }; case .failure(let error): model.error = tr(error.localizedDescription) }
            }
            .confirmationDialog(tr("Delete local project?"),isPresented:Binding(get:{deleting != nil},set:{if !$0 { deleting = nil }})) {
                Button(tr("Delete"),role:.destructive) { if let id = deleting?["id"].text { Task { await model.perform { try await model.store.delete(id); await model.reload() } } }; deleting = nil }
            }
            .alert(tr("提示"),isPresented:Binding(get:{model.error != nil},set:{if !$0 {model.error = nil}})) { Button(tr("知道了")) { model.error = nil } } message: { Text(model.error ?? "") }
            .sheet(item:$model.document) { document in StudioPreview(document:document) }
        }
    }
}
private struct LocalStudioEditor: View {
    @ObservedObject var model: LocalStudioModel
    @State private var importing = false
    @State private var imageImport = false
    @State private var characterIndex: Int?
    @State private var slot = "portrait"
    @State private var ooc = false
    @State private var secret = false
    private func text(_ key: String) -> Binding<String> { Binding(get:{model.project[key].text},set:{model.set(key,.string($0))}) }
    private func background(_ key: String) -> Binding<String> { Binding(get:{model.project["background"][key].text},set:{model.background(key,$0)}) }
    var body: some View {
        Form {
            Section(tr("Overview")) {
                TextField(tr("Title"),text:text("title"))
                TextField(tr("Era"),text:background("era"))
                TextField(tr("Special settings"),text:background("setting"),axis:.vertical)
                TextField(tr("Summary"),text:background("summary"),axis:.vertical)
                Text("\(model.project["events"].array.count) · " + tr("Lines")).foregroundStyle(.secondary)
                Button(tr("Add more logs…")) { importing = true }
                Button(tr("Choose background image")) { characterIndex = nil; imageImport = true }
                if !model.project["mobile_background"].text.isEmpty { StudioLocalImage(model:model,path:model.project["mobile_background"].text) }
            }
            Section(tr("Characters")) {
                ForEach(Array(model.project["characters"].array.enumerated()),id:\.offset) { index, character in
                    DisclosureGroup(character["name"].text) {
                        ForEach(["name","player","appearance"],id:\.self) { key in
                            TextField(tr(["name":"Name","player":"Player","appearance":"Appearance prompt","voice":"Voice"][key]!),text:Binding(get:{model.project["characters"].array[index][key].text},set:{model.character(index,key,.string($0))}),axis:.vertical)
                        }
                        Picker(tr("Role"),selection:Binding(get:{model.project["characters"].array[index]["kind"].text},set:{model.character(index,"kind",.string($0))})) { Text("PC").tag("pc"); Text("NPC").tag("npc"); Text("GM").tag("gm") }
                        ForEach(["avatar","portrait"],id:\.self) { key in
                            Button(tr(key == "avatar" ? "Upload avatar" : "Upload portrait")) { characterIndex = index; slot = key; imageImport = true }
                            if !character[key].text.isEmpty { StudioLocalImage(model:model,path:character[key].text) }
                        }
                    }
                }
            }
            StudioAIEditor(model:model)
            Section(tr("Export")) {
                Toggle(tr("Include OOC"),isOn:$ooc)
                Toggle(tr("Include secret messages"),isOn:$secret)
                ForEach([("html","Preview log"),("pdf","PDF"),("vn","Play visual novel"),("archive","Export project backup"),("native","Export native JSON"),("text","Plain text")],id:\.0) { action,label in
                    Button(tr(label)) { Task { await model.export(action,ooc:ooc,secret:secret) } }
                }
                Text(tr("Project backups include all messages and local images.")).font(.caption).foregroundStyle(.secondary)
            }
            if !model.project["issues"].array.isEmpty { Section(tr("Import notes")) { ForEach(Array(model.project["issues"].array.prefix(30).enumerated()),id:\.offset) { _, issue in Text(issue["reason"].text).font(.caption) } } }
        }.disabled(model.busy)
        .fileImporter(isPresented:$importing,allowedContentTypes:[.json,.plainText,.data],allowsMultipleSelection:true) { result in if case .success(let urls) = result { Task { await model.importFiles(urls,append:true) } } }
        .fileImporter(isPresented:$imageImport,allowedContentTypes:[.png,.jpeg,.webP]) { result in if case .success(let url) = result { Task { await model.picture(url,index:characterIndex,slot:slot) } } }
    }
}
private struct StudioLocalImage: View {
    @ObservedObject var model: LocalStudioModel
    let path: String
    @State private var image: UIImage?
    var body: some View {
        Group { if let image { Image(uiImage:image).resizable().scaledToFit().frame(maxHeight:220) } else { Image(systemName:"photo").foregroundStyle(.secondary).frame(height:80) } }
        .task(id:path) { let id = model.project["id"].text; image = try? await ArtworkImages.load("local-studio/" + id + "/" + path) { try await model.store.readAsset(id,path) } }
    }
}
private struct StudioPreview: View {
    let document: StudioDocument
    @State private var web: WKWebView?
    @State private var pdf: StudioDocument?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Group {
                if document.url.pathExtension == "html" { StudioDocumentWeb(url:document.url,script:document.kind == "vn",web:$web) }
                else { VStack(spacing:24) { Image(systemName:"doc.zipper").font(.largeTitle); Text(tr("Export ready")); ShareLink(item:document.url) { Label(tr("Export"),systemImage:"square.and.arrow.up") } } }
            }.navigationTitle(document.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement:.cancellationAction) { Button(tr("完成")) { dismiss() } }
                ToolbarItem(placement:.primaryAction) {
                    if document.kind == "pdf" { Button(tr("Export PDF")) {
                        guard let web else { return }
                        do {
                            let url = document.url.deletingPathExtension().appendingPathExtension("pdf")
                            try StudioPDF.write(web: web, to: url)
                            pdf = StudioDocument(url:url,title:document.title,kind:"file")
                        } catch { self.error = tr(error.localizedDescription) }
                    }.disabled(web == nil) } else if document.url.pathExtension == "html" { ShareLink(item:document.url) { Image(systemName:"square.and.arrow.up") } }
                }
            }
        }
        .sheet(item:$pdf) { item in NavigationStack { VStack(spacing:24) { Text(tr("Export ready")); ShareLink(item:item.url) { Label(tr("Export PDF"),systemImage:"square.and.arrow.up") } }.toolbar { Button(tr("完成")) { pdf = nil } } } }
        .alert(tr("提示"),isPresented:Binding(get:{error != nil},set:{if !$0 {error = nil}})) { Button(tr("知道了")) { error = nil } } message: { Text(error ?? "") }
    }
}
@MainActor enum StudioPDF {
    private final class Renderer: UIPrintPageRenderer {
        override var paperRect: CGRect { CGRect(x:0,y:0,width:420,height:595) }
        override var printableRect: CGRect { paperRect.insetBy(dx:36,dy:36) }
    }
    static func write(web: WKWebView, to url: URL) throws {
        let renderer = Renderer()
        renderer.addPrintFormatter(web.viewPrintFormatter(),startingAtPageAt:0)
        let count = renderer.numberOfPages
        guard count > 0, count <= 300 else { throw LocalStudioError.invalidFile }
        renderer.prepare(forDrawingPages:NSRange(location:0,length:count))
        try UIGraphicsPDFRenderer(bounds:renderer.paperRect).writePDF(to:url) { context in
            for page in 0..<count { context.beginPage(); renderer.drawPage(at:page,in:renderer.paperRect) }
        }
    }
}
private struct StudioDocumentWeb: UIViewRepresentable {
    let url: URL; let script: Bool; @Binding var web: WKWebView?
    func makeUIView(context:Context) -> WKWebView {
        let config = WKWebViewConfiguration(); config.defaultWebpagePreferences.allowsContentJavaScript = script; config.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame:.zero,configuration:config); view.navigationDelegate = context.coordinator
        view.loadFileURL(url,allowingReadAccessTo:url.deletingLastPathComponent()); return view
    }
    func updateUIView(_ view:WKWebView,context:Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, WKNavigationDelegate {
        let parent: StudioDocumentWeb; init(_ parent:StudioDocumentWeb) { self.parent = parent }
        func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) { parent.web = webView }
        func webView(_ webView:WKWebView,decidePolicyFor action:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void) { decisionHandler(action.request.url?.isFileURL == true && action.request.url?.standardizedFileURL.path == parent.url.standardizedFileURL.path ? .allow : .cancel) }
    }
}
