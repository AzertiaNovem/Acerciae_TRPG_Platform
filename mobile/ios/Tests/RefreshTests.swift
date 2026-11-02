import XCTest
import AcerciaeCore
@testable import Acerciae

@MainActor final class RefreshTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try APIJSON.decoder().decode(type,from:Data(json.utf8)) }
    private func model() throws -> AppModel {
        let config=URLSessionConfiguration.ephemeral; config.protocolClasses=[RefreshProtocol.self]
        let client=BackendClient(address:try BackendAddress("https://refresh.test"),session:URLSession(configuration:config))
        let session=try decode(Session.self,#"{"token":"test-only","user":{"id":"user","username":"test","display_name":"Test"}}"#)
        let model=AppModel(client:client,session:session)
        model.channelId="channel"; model.windowId="window"; model.serverId="server"
        model.channel=try decode(JSONValue.self,RefreshProtocol.gm)
        model.windows=try decode([Resource].self,RefreshProtocol.windows)
        model.campaign=try decode(DemoCampaign.self,#"{"title":"Old","scene":"Old","messages":[],"documents":[{"id":"doc","title":"Cached","doc_type":"scene","version":1}],"highlights":[],"replay":[]}"#)
        RefreshProtocol.reset()
        return model
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
    static func reset() { lock.lock(); defer { lock.unlock() }; responses=[:] }
    static func set(_ key:String,status:Int,body:String) { lock.lock(); defer { lock.unlock() }; responses[key]=(status,body) }
    override class func canInit(with request:URLRequest)->Bool { request.url?.host=="refresh.test" }
    override class func canonicalRequest(for request:URLRequest)->URLRequest { request }
    override func startLoading() {
        let key=request.url!.lastPathComponent
        Self.lock.lock(); let override=Self.responses[key]; Self.lock.unlock()
        let fallback:String
        switch key {
        case "channel": fallback=Self.gm
        case "windows": fallback=Self.windows
        case "messages": fallback=#"[{"id":"message","content":"Fresh message","kind":"ooc","seq":1,"author_name":"Test"}]"#
        case "settings": fallback="{}"
        default: fallback="[]"
        }
        let (status,body)=override ?? (200,fallback)
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
