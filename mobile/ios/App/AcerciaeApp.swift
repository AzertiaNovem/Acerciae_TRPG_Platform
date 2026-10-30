import SwiftUI
import AcerciaeCore

@main struct AcerciaeApp: App {
    var body: some Scene { WindowGroup { RootView().preferredColorScheme(.dark) } }
}

@MainActor final class AppModel: ObservableObject {
    @Published var campaign: DemoCampaign?
    @Published var loadError: String?
    @Published var draft = ""
    @Published var role = tr("场外")
    let endpoint = ServiceConfiguration.backendRoot
    @Published var connection = "尚未检查"
    @Published var checking = false
    @Published var notice: String?
    @Published var session: Session?
    @Published var servers: [Resource] = []
    @Published var channels: [Resource] = []
    @Published var windows: [Resource] = []
    @Published var characters: [Resource] = []
    @Published var reminders: [Resource] = []
    @Published var scenes: [Resource] = []
    @Published var serverId = ""
    @Published var channelId = ""
    @Published var windowId = ""
    @Published var characterId = ""
    @Published var channel: JSONValue = .null
    @Published var serverSettings: JSONValue = .null
    @Published var busy = false
    @Published var hasOlder = false
    @Published var diceHint = ""
    @Published var result: String?
    private var client: BackendClient?
    private var epoch = UUID()
    private var drafts: [String: String] = [:]
    private var refreshing = false
    private var catalogUpdated = Date.distantPast
    private var polling = false
    var online: Bool { session != nil }
    var scopeKey: String { channelId + channel["my_role"].text + channel["player_group_id"].text + String(channel["player_group_version"].int) + channel["my_character_ids"].pretty }
    var studioAccess: String { AccessRules.studio(channel, serverSettings) }
    var studioAvailable: Bool { studioAccess == "open" }
    var serverRole: String { servers.first { $0.id == serverId }?["my_role"].text ?? "" }
    var canCreateChannel: Bool { AccessRules.canCreateChannel(role: serverRole, settings: serverSettings) }
    var gm: Bool { channel["my_role"].text == "gm" }
    var playable: [Resource] { characters.filter { $0["user_id"].text == session?.user.id || (gm && $0["kind"].text == "npc") } }
    var serverName: String { servers.first { $0.id == serverId }?.name ?? tr("服务器") }
    var windowName: String { windows.first { $0.id == windowId }?.name ?? tr("聊天") }
    func enabled(_ feature: String) -> Bool { !online || serverSettings["features"][feature].bool }
    init() {
        do {
            if let saved = try SessionStore.read() {
                guard ServiceConfiguration.acceptsSavedEndpoint(saved.endpoint) else { try SessionStore.clear(); return }
                client = try makeClient(); session = saved.session; campaign = nil
                if let code = saved.session.user.uiLanguage { MobileLocale.shared.set(code) }
                connection = "正在恢复登录…"
            }
        } catch { notice = tr("无法读取已保存的登录，请重新登录") }
    }
    func makeClient() throws -> BackendClient {
        #if DEBUG
        let local = true
        #else
        let local = false
        #endif
        return BackendClient(address: try BackendAddress(endpoint, allowLocalHTTP: local))
    }
    func login(_ username: String, _ password: String, registering: Bool = false, displayName: String = "") async {
        guard !busy else { return }; busy = true
        defer { busy = false }
        do {
            let api = try makeClient()
            let auth: Session
            if registering { auth = try await api.register(username: username, password: password, displayName: displayName) }
            else { auth = try await api.login(username: username, password: password) }
            epoch = UUID(); client = api; session = auth; draft = ""; drafts = [:]
            if let code = auth.user.uiLanguage { MobileLocale.shared.set(code) }
            do { try SessionStore.save(SavedLogin(endpoint: endpoint, session: auth)) }
            catch { notice = tr("登录成功，但设备未能安全保存登录状态") }
            catalogUpdated = .distantPast
            campaign = nil; clearChannel(); servers = []; channels = []
            let stamp = epoch
            let fetched: [Resource] = try await api.request(["servers"], token: auth.token)
            guard stamp == epoch else { return }; servers = fetched
            if let first = servers.first { try await selectServer(first.id) }
            connection = "Connected · refreshing automatically"
        } catch ClientError.http(409) { notice = tr("用户名已被使用，请换一个用户名") }
        catch ClientError.http(401) { notice = tr("用户名或密码不正确") }
        catch { handle(error) }
    }
    func changeLanguage(_ code: String) async {
        guard InterfaceLanguage.codes.contains(code) else { return }
        if !online { MobileLocale.shared.set(code); return }
        await run {
            guard let api = self.client, let auth = self.session else { return }
            let user: User = try await api.request(["auth", "me"], token: auth.token, body: JSONEncoder().encode(["ui_language": code]), method: "PUT")
            guard self.session?.token == auth.token else { return }
            let updated = Session(token: auth.token, user: user)
            self.session = updated; MobileLocale.shared.set(user.uiLanguage ?? code)
            try SessionStore.save(SavedLogin(endpoint: self.endpoint, session: updated))
        }
    }
    func logout() {
        let api = client; let token = session?.token
        do { try SessionStore.clear() } catch { notice = tr("设备未能清除登录记录，请保持联网完成退出") }
        catalogUpdated = .distantPast
        epoch = UUID(); session = nil; client = nil; servers = []; channels = []; serverId = ""; serverSettings = .null
        clearChannel(); drafts = [:]; draft = ""; role = tr("场外"); connection = "已退出登录"
        if let api, let token { Task { _ = try? await api.resource(["auth", "logout"], token: token, body: .object([:])) } }
    }
    private func clearChannel() {
        channelId = ""; windowId = ""; characterId = ""; channel = .null
        windows = []; characters = []; scenes = []; reminders = []; campaign = nil; hasOlder = false; diceHint = ""; result = nil
    }
    func selectServer(_ id: String) async throws {
        if !windowId.isEmpty { drafts[windowId] = draft }
        epoch = UUID(); let stamp = epoch
        serverId = id; clearChannel(); channels = []; serverSettings = .null; draft = ""
        let settings = try await get(["servers", id, "settings"])
        let rows: [Resource] = try await typed(["servers", id, "channels"])
        guard epoch == stamp else { return }
        serverSettings = settings; channels = rows
        if let first = rows.first { try await selectChannel(first.id) }
    }
    func selectChannel(_ id: String) async throws {
        if !windowId.isEmpty { drafts[windowId] = draft }
        epoch = UUID(); let stamp = epoch
        clearChannel(); channelId = id; draft = ""
        let info = try await get(["channels", id])
        let wins: [Resource] = try await typed(["channels", id, "windows"])
        let chars: [Resource] = try await typed(["channels", id, "characters"])
        let stages: [Resource] = try await typed(["channels", id, "scenes"])
        guard epoch == stamp else { return }
        channel = info; windows = wins; characters = chars; scenes = stages
        characterId = playable.first?.id ?? ""; role = playable.first?.name ?? (gm ? tr("旁白") : tr("场外"))
        if let first = wins.first { try await selectWindow(first.id) }
    }
    func selectWindow(_ id: String) async throws {
        if !windowId.isEmpty { drafts[windowId] = draft }
        epoch = UUID(); windowId = id; draft = drafts[id] ?? ""; campaign = nil; diceHint = ""; result = nil
        try await refresh(merge: false)
    }
    func typed<T: Decodable>(_ path: [String], query: [String: String] = [:]) async throws -> T {
        guard let client, let session else { throw ClientError.http(401) }
        return try await client.request(path, token: session.token, query: query)
    }
    func get(_ path: [String], body: JSONValue? = nil, method: String? = nil, query: [String: String] = [:]) async throws -> JSONValue {
        guard let client, let session else { throw ClientError.http(401) }
        return try await client.resource(path, token: session.token, body: body, method: method, query: query)
    }
    func bytes(_ path: [String], query: [String: String] = [:]) async throws -> Data {
        guard let client, let session else { throw ClientError.http(401) }
        return try await client.bytes(path, token: session.token, query: query)
    }
    func uploadArtwork(_ data: Data, character: String, slot: String, subtitle: String) async throws -> JSONValue {
        guard let client, let session else { throw ClientError.http(401) }
        return try await client.uploadCharacterAsset(channel: channelId, character: character, slot: slot, subtitle: subtitle, data: data, token: session.token)
    }
    func refresh(merge: Bool = true) async throws {
        guard online, !windowId.isEmpty, !refreshing else { return }
        refreshing = true; defer { refreshing = false }
        let stamp = epoch; let c = channelId; let w = windowId
        let messages: [Message] = try await typed(["channels", c, "windows", w, "messages"], query: ["limit": "50"])
        let info = try await get(["channels", c])
        let isGM = info["my_role"].text == "gm"
        let docs: [DocumentSummary] = isGM ? try await typed(["channels", c, "documents"]) : []
        let hints: [Highlight] = isGM ? try await typed(["channels", c, "highlights"]) : []
        let reminders: [Resource] = try await typed(["channels", c, "reminders"])
        let settings = try await get(["servers", serverId, "settings"])
        let wins: [Resource] = try await typed(["channels", c, "windows"])
        let chars: [Resource] = try await typed(["channels", c, "characters"])
        let stages: [Resource] = try await typed(["channels", c, "scenes"])
        guard stamp == epoch else { return }
        let permissionsChanged = channel["player_group_id"] != info["player_group_id"] || channel["player_group_version"] != info["player_group_version"] || channel["my_role"] != info["my_role"] || channel["my_character_ids"] != info["my_character_ids"] || channel["knowledge_mode"] != info["knowledge_mode"] || windows.first { $0.id == w }?["members"] != wins.first { $0.id == w }?["members"]
        if permissionsChanged { result = nil; diceHint = "" }
        var all = merge && !permissionsChanged ? campaign?.messages ?? [] : []
        for message in messages { all.removeAll { $0.id == message.id }; all.append(message) }
        all.sort { $0.seq < $1.seq }
        // Decode the view model through the same fixture contract without inventing server fields.
        let payload: JSONValue = .object(["title": .string(info["name"].text), "scene": .string(wins.first { $0.id == w }?["scene_title"].text ?? ""), "messages": .array([]), "documents": .array([]), "highlights": .array([]), "replay": .array([])])
        var view = try DemoCampaign.decode(JSONEncoder().encode(payload))
        view.messages = all; view.documents = docs; view.highlights = hints
        self.reminders = reminders
        campaign = view; serverSettings = settings; channel = info; windows = wins; characters = chars; scenes = stages
        if !characterId.isEmpty && !playable.contains(where: { $0.id == characterId }) { characterId = ""; role = gm ? tr("旁白") : tr("场外") }
        if !merge || permissionsChanged { hasOlder = messages.count == 50 }
        connection = "已连接 · 自动刷新"
    }
    // Reconcile membership before reusing cached channel data, including empty accounts.
    func refreshCatalog() async throws {
        guard online else { return }
        let stamp = epoch
        let profile: User = try await typed(["auth", "me"])
        let fetched: [Resource] = try await typed(["servers"])
        guard stamp == epoch else { return }
        if let auth = session, profile.uiLanguage != auth.user.uiLanguage || profile.avatarVersion != auth.user.avatarVersion || profile.displayName != auth.user.displayName {
            session = Session(token: auth.token, user: profile); if let code = profile.uiLanguage { MobileLocale.shared.set(code) }
            try? SessionStore.save(SavedLogin(endpoint: endpoint, session: session!))
        }
        servers = fetched
        if !fetched.contains(where: { $0.id == serverId }) {
            epoch = UUID(); serverId = ""; channels = []; serverSettings = .null; clearChannel()
            if let first = fetched.first { try await selectServer(first.id) }
        } else {
            let rows: [Resource] = try await typed(["servers", serverId, "channels"])
            let settings = try await get(["servers", serverId, "settings"])
            guard stamp == epoch else { return }
            channels = rows; serverSettings = settings
            if !rows.contains(where: { $0.id == channelId }) {
                epoch = UUID(); clearChannel()
                if let first = rows.first { try await selectChannel(first.id) }
            } else if windowId.isEmpty { try await selectChannel(channelId) }
        }
        catalogUpdated = Date()
    }
    func poll(forceCatalog: Bool = false) async {
        guard online, !busy, !polling else { return }
        polling = true; defer { polling = false }
        let token = session?.token
        do {
            if forceCatalog || Date().timeIntervalSince(catalogUpdated) >= 30 { try await refreshCatalog() }
            try await refresh()
        } catch { if !Task.isCancelled && session?.token == token { handle(error, silent: true) } }
    }
    func older() async {
        guard let seq = campaign?.messages.first?.seq else { return }
        await run {
            let stamp = self.epoch
            let rows: [Message] = try await self.typed(["channels", self.channelId, "windows", self.windowId, "messages"], query: ["limit": "50", "before_seq": String(seq)])
            guard stamp == self.epoch else { return }
            let existing = Set(self.campaign?.messages.map(\.id) ?? [])
            self.campaign?.messages.insert(contentsOf: rows.filter { !existing.contains($0.id) }, at: 0)
            self.hasOlder = rows.count == 50
        }
    }
    func chooseRole(_ id: String) { characterId = id; role = playable.first { $0.id == id }?.name ?? (gm ? tr("旁白") : tr("场外")); diceHint = "" }
    func sendDemo() { guard online else { return }; Task { await send() } }
    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !windowId.isEmpty else { return }
        await run {
            let stamp = self.epoch
            var body: [String: JSONValue] = ["content": .string(text), "kind": .string(self.characterId.isEmpty ? (self.gm ? "narration" : "ooc") : "ic"), "visibility": .string("window")]
            if !self.characterId.isEmpty { body["character_id"] = .string(self.characterId) }
            _ = try await self.get(["channels", self.channelId, "windows", self.windowId, "messages"], body: .object(body))
            guard stamp == self.epoch else { return }
            if self.draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { self.draft = "" }
            self.diceHint = ""
            try await self.refresh()
        }
    }
    func assistance(_ type: String) async {
        guard type != "consistency" || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard online else { notice = tr("请先在设置中连接服务器"); return }
        await run {
            let stamp = self.epoch; let original = self.draft
            var body: [String: JSONValue] = ["chat_window_id": .string(self.windowId)]
            if !self.characterId.isEmpty { body["character_id"] = .string(self.characterId) }
            body[type == "consistency" ? "draft" : "hint"] = .string(original)
            let value = try await self.get(["channels", self.channelId, type], body: .object(body))
            guard stamp == self.epoch else { return }
            if type == "inspiration" {
                // Keep existing typing intact; the sheet requires explicit adoption.
                self.result = value["draft"].text
            } else {
                self.result = (value["insufficient_evidence"].bool ? tr("证据不足") : value["score_label"].text) + "\n\n" + value["rationale"].text + "\n\n证据与冲突\n" + value["evidence"].array.map { $0["summary"].text + "\n" + $0["scene_title"].text }.joined(separator: "\n\n") + "\n" + value["conflicts"].array.map { $0["description"].text }.joined(separator: "\n")
            }
        }
    }
    func previewDice() async {
        guard online, enabled("dice"), !windowId.isEmpty, draft.trimmingCharacters(in: .whitespaces).hasPrefix(".") else { diceHint = ""; return }
        let text = draft; let stamp = epoch
        var body: [String: JSONValue] = ["content": .string(text), "chat_window_id": .string(windowId)]
        if !characterId.isEmpty { body["character_id"] = .string(characterId) }
        do { let value = try await get(["channels", channelId, "dice", "preview"], body: .object(body)); if epoch == stamp && draft == text { diceHint = value["hint"].text } }
        catch { if epoch == stamp { diceHint = tr("命令预览不可用；发送时由服务器校验") } }
    }
    func run(_ work: () async throws -> Void) async {
        guard !busy else { return }; busy = true
        defer { busy = false }
        do { try await work() } catch { handle(error) }
    }
    func handle(_ error: Error, silent: Bool = false) {
        if case ClientError.http(401) = error { logout(); notice = tr("登录已过期，请重新登录"); return }
        if silent, let e = error as? ClientError, [403, 404].contains(e.httpStatus ?? 0) { epoch = UUID(); clearChannel(); catalogUpdated = .distantPast }
        connection = error is ClientError ? error.localizedDescription : tr("连接失败，请重试")
        if !silent { notice = connection }
    }
    func checkConnection() async {
        guard !checking else { return }; checking = true; defer { checking = false }
        do { let health = try await makeClient().health(); connection = "\(health.status) · 数据库 \(health.db) · LLM \(health.llmMode)" }
        catch { handle(error) }
    }
}
