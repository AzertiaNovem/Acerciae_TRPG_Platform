import SwiftUI
import AVFoundation
import AcerciaeCore

@main struct AcerciaeApp: App {
    var body: some Scene { WindowGroup { RootView().preferredColorScheme(.dark) } }
}

@MainActor final class AppModel: ObservableObject {
    @Published var chatNotices: [ChatNotice] = []
    @Published var initiative: JSONValue = .null
    @Published var bannersEnabled = UserDefaults.standard.object(forKey: "chatBanners") as? Bool ?? true
    @Published var readAloud = UserDefaults.standard.bool(forKey: "readAloud")
    var foreground = false { didSet { if !foreground { metadataTask?.cancel(); metadataTask = nil; metadataGeneration = UUID(); metadataUpdated = .distantPast } } }
    var chatVisible = false
    let speech = AVSpeechSynthesizer()
    private var readSeq: [String: Int64] = [:]
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
    @Published var speechMode = "ooc"
    @Published var resultType = ""
    @Published var references: [Message] = []
    @Published var jumpMessageId: String?
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
    func enabled(_ feature: String) -> Bool { !online || FeatureAccess.enabled(feature, server: serverSettings, channel: channel) }
    init(client injectedClient: BackendClient? = nil, session injectedSession: Session? = nil) {
        if let client = injectedClient, let session = injectedSession { self.client = client; self.session = session; return }
        do {
            if let saved = try SessionStore.read() {
                guard ServiceConfiguration.acceptsSavedEndpoint(saved.endpoint) else { try SessionStore.clear(); return }
                client = try makeClient().withAssets(assets(for: saved.session.user)); session = saved.session; campaign = nil
                if let code = saved.session.user.uiLanguage { MobileLocale.shared.set(code) }
                connection = "正在恢复登录…"
            }
        } catch { notice = tr("无法读取已保存的登录，请重新登录") }
    }
    // Downloaded media, one directory per account and server (AcerciaeCore/AssetDiskCache.swift); deleted on sign-out.
    private var assetRoot: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("assets", isDirectory: true) }
    private func assets(for user: User) -> AssetDiskCache { AssetDiskCache(directory: assetRoot.appendingPathComponent(AssetDiskCache.hex("\(endpoint)|\(user.id)"), isDirectory: true)) }
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
            epoch = UUID(); client = api.withAssets(assets(for: auth.user)); session = auth; draft = ""; drafts = [:]
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
    func changeAtmosphere(_ enabled: Bool) async {
        await run {
            guard let api = self.client, let auth = self.session else { return }
            let user: User = try await api.request(["auth", "me"], token: auth.token, body: JSONEncoder().encode(["atmosphere_enabled": enabled]), method: "PUT")
            guard self.session?.token == auth.token else { return }
            let updated = Session(token: auth.token, user: user)
            self.session = updated
            try SessionStore.save(SavedLogin(endpoint: self.endpoint, session: updated))
        }
    }
    func logout() {
        let api = client; let token = session?.token
        do { try SessionStore.clear() } catch { notice = tr("设备未能清除登录记录，请保持联网完成退出") }
        catalogUpdated = .distantPast
        epoch = UUID(); session = nil; client = nil; servers = []; channels = []; serverId = ""; serverSettings = .null
        try? FileManager.default.removeItem(at: assetRoot)   // no media of this account stays
        clearChannel(); drafts = [:]; draft = ""; role = tr("场外"); connection = "已退出登录"
        if let api, let token { Task { _ = try? await api.resource(["auth", "logout"], token: token, body: .object([:])) } }
    }
    private func clearChannel() {
        metadataTask?.cancel(); metadataTask = nil; metadataGeneration = UUID()
        metadataUpdated = .distantPast; failedPolls = 0; nextPoll = .distantPast
        chatNotices = []; initiative = .null; readSeq = [:]; speech.stopSpeaking(at:.immediate)
        channelId = ""; windowId = ""; characterId = ""; channel = .null; speechMode = "ooc"; references = []; jumpMessageId = nil
        windows = []; characters = []; scenes = []; reminders = []; campaign = nil; hasOlder = false; diceHint = ""; result = nil
    }
    func selectServer(_ id: String) async throws {
        if !windowId.isEmpty { drafts[windowId] = draft }
        epoch = UUID(); let stamp = epoch
        serverId = id; clearChannel(); channels = []; serverSettings = .null; draft = ""
        let rows: [Resource] = try await typed(["servers", id, "channels"])
        guard epoch == stamp else { return }
        channels = rows
        if let first = rows.first { try await selectChannel(first.id) }
        else { serverSettings = try await get(["servers",id,"settings"]) }
    }
    func selectChannel(_ id: String) async throws {
        if !windowId.isEmpty { drafts[windowId] = draft }
        epoch = UUID(); let stamp = epoch
        clearChannel(); channelId = id; draft = ""
        let info = try await get(["channels", id])
        let wins: [Resource] = try await typed(["channels", id, "windows"])
        guard epoch == stamp else { return }
        channel = info; windows = wins
        characterId = playable.first?.id ?? ""; role = playable.first?.name ?? (gm ? tr("旁白") : tr("场外"))
        if let first = wins.first { try await selectWindow(first.id) }
    }
    func selectWindow(_ id: String) async throws {
        if !windowId.isEmpty { drafts[windowId] = draft }
        epoch = UUID(); references = []; jumpMessageId = nil; speechMode = gm ? "narration" : "ic"; windowId = id; draft = drafts[id] ?? ""; campaign = nil; diceHint = ""; result = nil
        try await refresh(merge: false,metadata:false)
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
    func uploadModule(_ data: Data, title: String) async throws -> JSONValue {
        guard let client, let session else { throw ClientError.http(401) }
        return try await client.uploadModule(channel: channelId, title: title, data: data, token: session.token)
    }
    private var metadataTask: Task<Void,Never>?
    private var metadataGeneration = UUID()
    private var metadataUpdated = Date.distantPast
    private var failedPolls = 0
    private var nextPoll = Date.distantPast
    private func auxiliary<T>(_ work: () async throws -> T, cached: T, empty: T) async throws -> T {
        do { return try await work() }
        catch {
            if Task.isCancelled { throw CancellationError() }
            if case ClientError.http(401) = error { throw error }
            if let e = error as? ClientError, [403,404].contains(e.httpStatus ?? 0) { return empty }
            connection = tr("聊天已连接，部分内容暂未更新，将自动重试")
            return cached
        }
    }
    func refresh(merge: Bool = true, metadata: Bool = true) async throws {
        guard online, !windowId.isEmpty, !refreshing else { return }
        refreshing = true; defer { refreshing = false }
        let stamp = epoch; let c = channelId; let w = windowId; let server = serverId
        async let infoRequest = get(["channels",c])
        async let windowsRequest: [Resource] = typed(["channels",c,"windows"])
        let (info,wins) = try await (infoRequest,windowsRequest)
        guard stamp == epoch else { return }
        let isGM = info["my_role"].text == "gm"
        let permissionsChanged = channel["player_group_id"] != info["player_group_id"] || channel["player_group_version"] != info["player_group_version"] || channel["my_role"] != info["my_role"] || channel["my_character_ids"] != info["my_character_ids"] || channel["knowledge_mode"] != info["knowledge_mode"] || windows.first { $0.id == w }?["members"] != wins.first { $0.id == w }?["members"]
        if permissionsChanged {
            metadataTask?.cancel(); metadataTask = nil; metadataGeneration = UUID()
            chatNotices = []; readSeq = [:]; speech.stopSpeaking(at:.immediate); result = nil; diceHint = ""; references = []; jumpMessageId = nil
            campaign = nil; characters = []; scenes = []; reminders = []
            if channel["my_role"] != info["my_role"] { speechMode = isGM ? "narration" : "ic" }
        }
        channel = info; windows = wins
        let messages: [Message] = try await typed(["channels",c,"windows",w,"messages"],query:["limit":"50"])
        guard stamp == epoch else { return }
        var all = merge && !permissionsChanged ? campaign?.messages ?? [] : []
        for message in messages { all.removeAll { $0.id == message.id }; all.append(message) }
        all.sort { $0.seq < $1.seq }
        let payload: JSONValue = .object(["title":.string(info["name"].text),"scene":.string(wins.first { $0.id == w }?["scene_title"].text ?? ""),"messages":.array([]),"documents":.array([]),"highlights":.array([]),"replay":.array([])])
        var view = try DemoCampaign.decode(JSONEncoder().encode(payload))
        view.messages = all; view.documents = isGM ? campaign?.documents ?? [] : []; view.highlights = isGM ? campaign?.highlights ?? [] : []
        campaign = view; channel = info; windows = wins
        if !merge || permissionsChanged { hasOlder = messages.count == 50 }
        connection = "已连接 · 自动刷新"
        // Publish the authorized chat before optional metadata; one failed hint request must not discard messages.
        if metadata || permissionsChanged || (metadataTask == nil && Date().timeIntervalSince(metadataUpdated) >= 30) {
            metadataUpdated = Date()
            metadataTask?.cancel(); let generation = UUID(); metadataGeneration = generation
            let scope = scopeKey
            let updateMetadata: () async throws -> Void = { [self] in
            async let docs: [DocumentSummary] = auxiliary({ isGM ? try await self.typed(["channels",c,"documents"]) : [] },cached:view.documents,empty:[])
            async let hints: [Highlight] = auxiliary({ isGM ? try await self.typed(["channels",c,"highlights"]) : [] },cached:view.highlights,empty:[])
            async let reminders: [Resource] = auxiliary({ try await self.typed(["channels",c,"reminders"]) },cached:self.reminders,empty:[])
            async let settings = auxiliary({ try await self.get(["servers",server,"settings"]) },cached:serverSettings,empty:.null)
            async let chars: [Resource] = auxiliary({ try await self.typed(["channels",c,"characters"]) },cached:characters,empty:[])
            async let stages: [Resource] = auxiliary({ try await self.typed(["channels",c,"scenes"]) },cached:scenes,empty:[])
            let values = try await (docs,hints,reminders,settings,chars,stages)
            try Task.checkCancellation()
            guard stamp == epoch && scope == scopeKey else { return }
            campaign?.documents = values.0; campaign?.highlights = values.1; self.reminders = values.2
            serverSettings = values.3; characters = values.4; scenes = values.5
            if characterId.isEmpty && speechMode == "ic", let first = playable.first { characterId = first.id; role = first.name }
            }
            if metadata { try await updateMetadata() }
            else {
                metadataTask = Task { [self] in
                    defer { if metadataGeneration == generation { metadataTask = nil } }
                    do { try await updateMetadata() }
                    catch { if !Task.isCancelled && stamp == epoch && scope == scopeKey { handle(error,silent:true) } }
                }
            }
        }
        if !characterId.isEmpty && !playable.contains(where: { $0.id == characterId }) { characterId = ""; role = gm ? tr("旁白") : tr("场外") }
    }
    // Reconcile membership before reusing cached channel data, including empty accounts.
    func refreshCatalog() async throws {
        guard online else { return }
        let stamp = epoch
        let profile: User = try await typed(["auth", "me"])
        let fetched: [Resource] = try await typed(["servers"])
        guard stamp == epoch else { return }
        if let auth = session, profile.uiLanguage != auth.user.uiLanguage || profile.avatarVersion != auth.user.avatarVersion || profile.hasAvatar != auth.user.hasAvatar || profile.displayName != auth.user.displayName || profile.atmosphereEnabled != auth.user.atmosphereEnabled {
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
    func dismissNotice(_ id: String) { chatNotices.removeAll { $0.id == id } }
    func setBanners(_ on: Bool) { bannersEnabled = on; UserDefaults.standard.set(on, forKey:"chatBanners"); if !on { chatNotices = [] } }
    func setReadAloud(_ on: Bool) { readAloud = on; UserDefaults.standard.set(on, forKey:"readAloud"); if !on { speech.stopSpeaking(at:.immediate) } }
    func initiativeAction(_ action: String, entry: String = "") async { await run { initiative = try await get(["channels",channelId,"windows",windowId,"initiative"],body:.object(["action":.string(action),"entry_id":.string(entry)])) } }
    private func updateActivity(previous: [Resource], previousMessages: [Message]?, stamp: UUID, allowSpeech: Bool) async throws {
        guard !Task.isCancelled, foreground, stamp == epoch, let user = session?.user.id else { return }
        let c = channelId, w = windowId
        chatNotices.removeAll { n in !windows.contains { $0.id == n.id && ($0["kind"].text == "main" || $0["members"].array.contains { $0["user_id"].text == user }) } || (chatVisible && n.id == w) }
        if bannersEnabled {
            for win in windows where WindowActivity.shouldNotify(previous: previous.first { $0.id == win.id }?.value ?? .null,current:win.value,user:user,viewing:chatVisible ? w : "") {
                let old = previous.first { $0.id == win.id }?["last_seq"].int ?? 0
                let rows: [Message] = try await typed(["channels",c,"windows",win.id,"messages"],query:["limit":"24"])
                guard !Task.isCancelled, foreground, stamp == epoch else { return }
                let incoming = rows.filter { $0.seq > old && $0.authorId != user }
                if !incoming.isEmpty {
                    let prior = chatNotices.first { $0.id == win.id }?.messages ?? []
                    dismissNotice(win.id); let merged = Dictionary((incoming + prior).map { ($0.id,$0) },uniquingKeysWith: { a,_ in a }).values.sorted { $0.seq > $1.seq }
                    chatNotices.insert(ChatNotice(id:win.id,title:win.name,messages:Array(merged.prefix(24))),at:0); chatNotices = Array(chatNotices.prefix(4))
                }
            }
        }
        guard stamp == epoch, chatVisible else { return }
        if channel["rule_system"].text == "dnd2024" { let value = try await get(["channels",c,"windows",w,"initiative"]); guard stamp == epoch else { return }; initiative = value }
        guard !Task.isCancelled, foreground, chatVisible, stamp == epoch else { return }
        if allowSpeech && readAloud, let previousMessages, let newest = previousMessages.map(\.seq).max() {
            let fresh = (campaign?.messages ?? []).filter { $0.seq > newest && $0.authorId != user && $0.kind != "system" }
            for message in fresh.suffix(5) { let utterance = AVSpeechUtterance(string:String(message.displayText.prefix(1500))); utterance.voice = AVSpeechSynthesisVoice(language:serverSettings["language"].text); speech.speak(utterance) }
        }
        if let seq = campaign?.messages.map(\.seq).max(), seq > (readSeq[w] ?? -1), windows.first(where: { $0.id == w })?["unread"] != .null {
            _ = try await get(["channels",c,"windows",w,"read"],body:.object(["seq":.number(Double(seq))])); guard stamp == epoch else { return }; readSeq[w] = seq
        }
    }
    func poll(forceCatalog: Bool = false) async {
        guard online, !busy, !polling, forceCatalog || Date() >= nextPoll else { return }
        polling = true; defer { polling = false }
        let token = session?.token
        let previousScope = scopeKey; let previous = windows; let previousMessages = campaign?.messages; let stamp = epoch
        do {
            var catalogDeferred = false
            if forceCatalog || Date().timeIntervalSince(catalogUpdated) >= 30 {
                do { try await refreshCatalog() }
                catch {
                    if Task.isCancelled || windowId.isEmpty { throw error }
                    if case ClientError.http(401) = error { throw error }
                    catalogUpdated = Date(); catalogDeferred = true
                }
            }
            try await refresh(metadata:false)
            failedPolls = 0; nextPoll = .distantPast
            if previousScope == scopeKey { _ = try await auxiliary({ try await self.updateActivity(previous:previous,previousMessages:previousMessages,stamp:stamp,allowSpeech:!forceCatalog) },cached:(),empty:()) }
            if catalogDeferred { connection = tr("聊天已连接，部分内容暂未更新，将自动重试") }
        } catch { if !Task.isCancelled && session?.token == token { failedPolls = min(4,failedPolls + 1); nextPoll = Date().addingTimeInterval(Double(min(30,4 * (1 << failedPolls)))); handle(error, silent: true) } }
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
    func openEvidence(_ event: JSONValue, quote: Bool) async throws {
        let stamp = epoch; let sourceChannel = channelId; let sourceToken = session?.token
        let message: Message = try await typed(["channels", channelId, "messages", event["message_id"].text])
        guard stamp == epoch else { return }
        if quote {
            if !references.contains(where: { $0.id == message.id }) {
                guard references.count < 5 else { notice = tr("At most five chat references"); return }
                references.append(message)
            }
        } else {
            if event["chat_window_id"].text != windowId { try await selectWindow(event["chat_window_id"].text) }
            guard channelId == sourceChannel, session?.token == sourceToken, windowId == event["chat_window_id"].text else { return }
            if campaign?.messages.contains(where: { $0.id == message.id }) == false { campaign?.messages.append(message); campaign?.messages.sort { $0.seq < $1.seq } }
            jumpMessageId = message.id
        }
    }
    func chooseRole(_ id: String) { characterId = id; role = playable.first { $0.id == id }?.name ?? (gm ? tr("旁白") : tr("场外")); diceHint = "" }
    func sendDemo() { guard online else { return }; Task { await send() } }
    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !windowId.isEmpty else { return }
        await run {
            let stamp = self.epoch
            var body: [String: JSONValue] = ["content": .string(text), "kind": .string(self.speechMode), "visibility": .string("window")]
            if !self.characterId.isEmpty { body["character_id"] = .string(self.characterId) }
            body["reference_ids"] = .array(self.references.map { .string($0.id) })
            _ = try await self.get(["channels", self.channelId, "windows", self.windowId, "messages"], body: .object(body))
            guard stamp == self.epoch else { return }
            if self.draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { self.draft = "" }
            self.diceHint = ""; self.references = []
            try await self.refresh()
        }
    }
    func assistance(_ type: String) async {
        guard enabled(type), !windowId.isEmpty else { return }
        guard type != "consistency" || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard online else { notice = tr("请先在设置中连接服务器"); return }
        await run {
            let stamp = self.epoch; let original = self.draft
            var body: [String: JSONValue] = ["chat_window_id": .string(self.windowId)]
            if !self.characterId.isEmpty { body["character_id"] = .string(self.characterId) }
            body[type == "consistency" ? "draft" : "hint"] = .string(original)
            let value = try await self.get(["channels", self.channelId, type], body: .object(body))
            guard stamp == self.epoch else { return }
            self.resultType = type
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
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
        if case ClientError.http(401) = error { logout(); notice = tr("登录已过期，请重新登录"); return }
        if silent, let e = error as? ClientError, [403, 404].contains(e.httpStatus ?? 0) { epoch = UUID(); clearChannel(); catalogUpdated = .distantPast }
        if case ClientError.gateway(let status) = error { connection = tr("服务入口暂时不可用，请稍后重试") + " (HTTP \(status))" }
        else { connection = tr(ConnectionPolicy.message(error)) }
        if !silent { notice = connection }
    }
    func checkConnection() async {
        guard !checking else { return }; checking = true; defer { checking = false }
        do { let health = try await makeClient().health(); connection = "\(health.status) · 数据库 \(health.db) · LLM \(health.llmMode)" }
        catch { handle(error) }
    }
}
