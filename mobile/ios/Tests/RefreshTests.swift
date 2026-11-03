import XCTest
import AcerciaeCore
@testable import Acerciae

@MainActor final class RefreshTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try APIJSON.decoder().decode(type,from:Data(json.utf8)) }
    private func model(cache: URL? = nil, assets: URL? = nil) throws -> AppModel {
        let config=URLSessionConfiguration.ephemeral; config.protocolClasses=[RefreshProtocol.self]
        let client=BackendClient(address:try BackendAddress("https://refresh.test"),session:URLSession(configuration:config),assets:assets.map { AssetDiskCache(directory:$0) },reads:AssetDiskCache(directory:cache ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)))
        let session=try decode(Session.self,#"{"token":"test-only","user":{"id":"user","username":"test","display_name":"Test"}}"#)
        let model=AppModel(client:client,session:session)
        model.channelId="channel"; model.windowId="window"; model.serverId="server"
        model.channel=try decode(JSONValue.self,RefreshProtocol.gm)
        model.windows=try decode([Resource].self,RefreshProtocol.windows)
        model.campaign=try decode(DemoCampaign.self,#"{"title":"Old","scene":"Old","messages":[],"documents":[{"id":"doc","title":"Cached","doc_type":"scene","version":1}],"highlights":[],"replay":[]}"#)
        RefreshProtocol.reset()
        return model
    }
    func testArtworkPrefetchDoesNotBlockChatAndStopsWhenBackgrounded() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let model = try model(assets: directory)
        RefreshProtocol.set("characters", status:200, body:#"[{"id":"hero","avatar_asset_id":"avatar","avatar_asset_version":7,"avatar_asset_hash":"avatar-hash"}]"#)
        RefreshProtocol.set("space", status:200, body:#"{"portrait":{"id":"portrait","version":3,"hash":"portrait-hash"}}"#)
        RefreshProtocol.mediaDelay = 1.0
        model.foreground = true
        try await model.refresh()
        XCTAssertNil(AssetDiskCache(directory: directory).get("sha:avatar-hash"), "Chat refresh returns while the slow artwork request is still pending")
        XCTAssertEqual(model.campaign?.messages.first?.content, "Fresh message")
        XCTAssertFalse(model.busy)
        model.draft = "Still typing while images download"
        let deadline = Date().addingTimeInterval(2)
        while !RefreshProtocol.paths.contains(where: { $0.contains("/media/") }) && Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(RefreshProtocol.paths.contains("/api/channels/channel/media/avatar?v=7"))
        model.foreground = false
        try await Task.sleep(for: .milliseconds(1100))
        XCTAssertFalse(RefreshProtocol.paths.contains(where: { $0.hasSuffix("/space") }))
        XCTAssertEqual(model.draft, "Still typing while images download")
        RefreshProtocol.mediaDelay = 0
        model.foreground = true
        try await model.refresh()
        let resumed = Date().addingTimeInterval(2)
        let cache = AssetDiskCache(directory: directory)
        while cache.get("sha:portrait-hash") == nil && Date() < resumed { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertNotNil(cache.get("sha:portrait-hash"))
        XCTAssertEqual(RefreshProtocol.paths.filter { $0.contains("/media/avatar") }.count, 1)
        model.foreground = false
    }
    func testRelaunchRestoresSavedSelectionAndMessagesBeforeNetworkCompletes() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = try model(cache: directory)
        RefreshProtocol.set("servers",status:200,body:#"[{"id":"server","name":"Server"}]"#)
        RefreshProtocol.set("channels",status:200,body:#"[{"id":"channel","name":"Chat"}]"#)
        let _: [Resource] = try await first.typed(["servers"])
        try await first.selectServer("server")
        first.foreground = false
        let restarted = try model(cache: directory)
        restarted.serverId = ""; restarted.channelId = ""; restarted.windowId = ""; restarted.channel = .null; restarted.windows = []; restarted.campaign = nil
        RefreshProtocol.delay = 0.6
        let work = Task { await restarted.poll(forceCatalog: true) }
        let deadline = Date().addingTimeInterval(0.4)
        while restarted.campaign == nil && Date() < deadline { try await Task.sleep(for:.milliseconds(5)) }
        XCTAssertEqual(restarted.serverId,"server"); XCTAssertEqual(restarted.channelId,"channel"); XCTAssertEqual(restarted.windowId,"window")
        XCTAssertEqual(restarted.campaign?.messages.first?.content,"Fresh message"); XCTAssertFalse(restarted.busy)
        work.cancel(); await work.value
        restarted.foreground = false
    }
    func testCachedChannelAppearsWhileGetIsSlowAndDraftRemainsEditable() async throws {
        let model = try model()
        try await model.selectChannel("channel")
        model.foreground = false
        model.campaign = nil
        RefreshProtocol.delay = 0.4
        RefreshProtocol.set("messages", status:200, body:#"[{"id":"message","content":"Updated after cache","kind":"ooc","seq":1,"author_name":"Test"}]"#)
        model.navigate { try await model.selectChannel("channel") }
        let deadline = Date().addingTimeInterval(0.3)
        while model.campaign == nil && Date() < deadline { try await Task.sleep(for:.milliseconds(5)) }
        XCTAssertEqual(model.campaign?.messages.first?.content,"Fresh message")
        XCTAssertFalse(model.busy)
        model.draft = "Draft typed during slow GET"
        let updated = Date().addingTimeInterval(3)
        while model.campaign?.messages.first?.content != "Updated after cache" && Date() < updated { try await Task.sleep(for:.milliseconds(10)) }
        XCTAssertEqual(model.campaign?.messages.first?.content,"Updated after cache")
        XCTAssertEqual(model.draft,"Draft typed during slow GET")
        model.foreground = false
    }
    func testOpeningChannelDoesNotWaitForAuxiliaryFailures() async throws {
        let model=try model(); model.foreground=true
        RefreshProtocol.set("characters",status:503,body:"busy")
        RefreshProtocol.set("scenes",status:503,body:"busy")
        let start=Date()
        try await model.selectChannel("channel")
        XCTAssertEqual(model.campaign?.messages.first?.content,"Fresh message")
        XCTAssertLessThan(Date().timeIntervalSince(start),1.0,"Channel opening must not wait for metadata retry delays")
        model.foreground=false
        try await Task.sleep(for:.milliseconds(50))
    }
    func testMetadataFailureDoesNotDiscardFreshMessagesOrCachedDocuments() async throws {
        let model=try model()
        RefreshProtocol.set("documents",status:503,body:"temporarily unavailable")
        try await model.refresh()
        XCTAssertEqual(model.campaign?.messages.first?.content,"Fresh message")
        XCTAssertEqual(model.campaign?.documents.first?.id,"doc")
        XCTAssertTrue(model.online)
    }
    func testMetadataPermissionFailureClearsThatCacheWithoutLosingChat() async throws {
        let model=try model()
        RefreshProtocol.set("documents",status:403,body:#"{"error":"forbidden"}"#)
        try await model.refresh()
        XCTAssertEqual(model.campaign?.messages.count,1)
        XCTAssertTrue(model.campaign?.documents.isEmpty == true)
        XCTAssertEqual(model.channelId,"channel")
    }
    func testPermissionChangeClearsPrivateCacheEvenIfMessagesFail() async throws {
        let model=try model()
        RefreshProtocol.set("channel",status:200,body:#"{"id":"channel","name":"Chat","my_role":"player"}"#)
        RefreshProtocol.set("messages",status:503,body:"unavailable")
        do { try await model.refresh(); XCTFail("Expected transport failure") } catch {}
        XCTAssertNil(model.campaign)
        XCTAssertFalse(model.gm)
    }
    func testGatewayDenialAndCancellationDoNotClearLoginOrChannel() throws {
        let model=try model()
        model.handle(ClientError.gateway(401),silent:true)
        XCTAssertTrue(model.online); XCTAssertEqual(model.channelId,"channel")
        model.notice=nil
        model.handle(CancellationError())
        XCTAssertNil(model.notice); XCTAssertTrue(model.online)
    }
}
private final class RefreshProtocol: URLProtocol, @unchecked Sendable {
    static let gm=#"{"id":"channel","name":"Chat","my_role":"gm"}"#
    static let windows=#"[{"id":"window","name":"Main","kind":"main","members":[]}]"#
    private static let lock=NSLock()
    private static var responses:[String:(Int,String)]=[:]
    private static var requests: [String] = []
    static var paths: [String] { lock.lock(); defer { lock.unlock() }; return requests }
    static var mediaDelay: Double = 0
    static var delay: Double = 0
    static func reset() { lock.lock(); defer { lock.unlock() }; responses=[:]; delay=0; mediaDelay=0; requests=[] }
    static func set(_ key:String,status:Int,body:String) { lock.lock(); defer { lock.unlock() }; responses[key]=(status,body) }
    override class func canInit(with request:URLRequest)->Bool { request.url?.host=="refresh.test" }
    override class func canonicalRequest(for request:URLRequest)->URLRequest { request }
    override func startLoading() {
        let key=request.url!.lastPathComponent
        Self.lock.lock(); let override=Self.responses[key]; Self.requests.append(request.url!.path + (request.url!.query.map { "?" + $0 } ?? "")); Self.lock.unlock()
        let fallback:String
        switch key {
        case "channel": fallback=Self.gm
        case "windows": fallback=Self.windows
        case "messages": fallback=#"[{"id":"message","content":"Fresh message","kind":"ooc","seq":1,"author_name":"Test"}]"#
        case "settings": fallback="{}"
        default: fallback="[]"
        }
        let (status,body)=override ?? (200,fallback)
        let media = request.url!.path.contains("/media/")
        let delay = media ? Self.mediaDelay : Self.delay
        DispatchQueue.global().asyncAfter(deadline:.now() + delay) { [self] in
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:["Content-Type":"application/json", "Cache-Control":media ? "private, immutable" : "no-cache"])!,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
