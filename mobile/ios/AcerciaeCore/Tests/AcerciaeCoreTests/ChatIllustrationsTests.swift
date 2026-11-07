import XCTest
@testable import AcerciaeCore

final class ChatIllustrationsTests: XCTestCase {
    private var directory: URL!
    override func setUp() { directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); IllustrationProtocol.reset() }
    override func tearDown() { try? FileManager.default.removeItem(at: directory) }
    private func client(account: String = "one") throws -> BackendClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [IllustrationProtocol.self]
        return BackendClient(address: try BackendAddress("https://illustration.test"), session: URLSession(configuration: config), assets: AssetDiskCache(directory: directory.appendingPathComponent(account)))
    }
    func testAttachmentSurvivesDiskRoundTripAndRecallHidesIt() throws {
        let data = Data(#"{"id":"line","channel_id":"channel","media_asset_id":"picture","content":"🖼️ 雨中的街道","author_name":"GM","kind":"ooc","seq":1}"#.utf8)
        let message = try APIJSON.decoder().decode(Message.self, from: data)
        XCTAssertTrue(message.hasIllustration); XCTAssertEqual(message.channelId, "channel")
        XCTAssertEqual(message.illustrationCaption, "雨中的街道")
        let restored = try APIJSON.decoder().decode(Message.self, from: JSONEncoder().encode(message))
        XCTAssertEqual(restored.mediaAssetId, "picture"); XCTAssertTrue(restored.hasIllustration)
        var withdrawn = restored; withdrawn.recalledAt = "2026-11-07T00:00:00Z"
        XCTAssertFalse(withdrawn.hasIllustration)
        let old = try APIJSON.decoder().decode(Message.self, from: Data(#"{"id":"old","content":"Plain text","author_name":"GM","kind":"ooc","seq":1}"#.utf8))
        XCTAssertFalse(old.hasIllustration)
        XCTAssertEqual(ChatIllustrations.caption("🖼 A room"), "A room")
        XCTAssertEqual(ChatIllustrations.caption("🖼️\nA room"), "A room")
        XCTAssertEqual(ChatIllustrations.caption("Text 🖼️ stays"), "Text 🖼️ stays")
    }
    func testMessageScopedAuthenticatedFetchPersistsAndIsIsolatedByAccount() async throws {
        let path = ChatIllustrations.path(channel: "channel", message: "line")
        let first = try client()
        let bytes = try await first.bytes(path, token: "fixture-session")
        XCTAssertEqual(bytes, Data("picture".utf8))
        XCTAssertEqual(IllustrationProtocol.requests.first?.url?.path, "/api/channels/channel/messages/line/image")
        XCTAssertEqual(IllustrationProtocol.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-session")
        XCTAssertNil(IllustrationProtocol.requests.first?.url?.query)
        _ = try await client().bytes(path, token: "fixture-session")
        XCTAssertEqual(IllustrationProtocol.requests.count, 1, "Disk survives a new client without another GET")
        _ = try await client(account: "two").bytes(path, token: "other-session")
        XCTAssertEqual(IllustrationProtocol.requests.count, 2, "Another account cannot reuse the private picture")
        await first.forgetMessageImage(channel: "channel", message: "line")
        XCTAssertNil(AssetDiskCache(directory: directory.appendingPathComponent("one")).get("https://illustration.test/api/channels/channel/messages/line/image"))
    }
    func testRecallRejectsALateDownloadCacheWrite() async throws {
        let c = try client(), path = ChatIllustrations.path(channel: "channel", message: "line")
        let task = Task { try await c.bytes(path, token: "fixture-session") }
        while IllustrationProtocol.requests.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        await c.forgetMessageImage(channel: "channel", message: "line")
        _ = try await task.value
        XCTAssertNil(c.assets?.get("https://illustration.test/api/channels/channel/messages/line/image"))
    }
    func testNoStoreStillPreventsPersistenceAndOtherRoutesRequireImmutable() async throws {
        IllustrationProtocol.cacheControl = "private, max-age=86400, no-store"
        let path = ChatIllustrations.path(channel: "channel", message: "line")
        _ = try await client().bytes(path, token: "fixture-session")
        _ = try await client().bytes(path, token: "fixture-session")
        XCTAssertEqual(IllustrationProtocol.requests.count, 2)
        XCTAssertFalse(ChatIllustrations.keepable("private, max-age=86400", path: ["channels", "channel", "media", "picture"]))
        XCTAssertFalse(ChatIllustrations.keepable("private, max-age=0", path: path))
        XCTAssertFalse(ChatIllustrations.keepable("private, max-age=86400, no-cache", path: path))
    }
}
private final class IllustrationProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var sent: [URLRequest] = []
    private static var control = "private, max-age=86400"
    static var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return sent }
    static var cacheControl: String { get { lock.lock(); defer { lock.unlock() }; return control } set { lock.lock(); control = newValue; lock.unlock() } }
    static func reset() { lock.lock(); sent = []; control = "private, max-age=86400"; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "illustration.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.sent.append(request); let cacheControl = Self.control; Self.lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png", "Cache-Control": cacheControl])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("picture".utf8)); client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
