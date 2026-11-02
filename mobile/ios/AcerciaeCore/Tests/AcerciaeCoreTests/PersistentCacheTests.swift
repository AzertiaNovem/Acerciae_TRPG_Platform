import XCTest
@testable import AcerciaeCore

final class PersistentCacheTests: XCTestCase {
    private var directory: URL!
    override func setUp() { directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); CacheProtocol.reset() }
    override func tearDown() { try? FileManager.default.removeItem(at: directory) }
    private func client(account: String = "one") throws -> BackendClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CacheProtocol.self]
        return BackendClient(address: try BackendAddress("https://cache.test"), session: URLSession(configuration: config),
            assets: AssetDiskCache(directory: directory.appendingPathComponent(account + "/assets")),
            reads: AssetDiskCache(directory: directory.appendingPathComponent(account + "/pages")))
    }
    func testPagesSurviveClientRestartAndRequireExplicitRevalidation() async throws {
        let first = try client()
        let rows = try await first.servers(token: "not-stored")
        let restarted = try client()
        let cached: [Resource]? = await restarted.cached(["servers"])
        XCTAssertEqual(cached?.first?.id, rows.first?.id); XCTAssertEqual(CacheProtocol.count, 1)
        let isolated: [Resource]? = try await client(account: "two").cached(["servers"])
        XCTAssertNil(isolated)
        _ = try await restarted.servers(token: "not-stored")
        XCTAssertEqual(CacheProtocol.count, 2, "Fresh GET must still reach the backend")
    }
    func testAssetsCoalescePersistAndUseVersionedKeys() async throws {
        let first = try client(); let path = ["channels","channel","media","portrait"]
        try await withThrowingTaskGroup(of: Data.self) { group in
            for _ in 0..<8 { group.addTask { try await first.bytes(path, token: "test", query: ["v":"1"]) } }
            for try await value in group { XCTAssertEqual(value, Data("image".utf8)) }
        }
        XCTAssertEqual(CacheProtocol.count, 1)
        _ = try await client().bytes(path, token: "test", query: ["v":"1"])
        XCTAssertEqual(CacheProtocol.count, 1)
        _ = try await first.bytes(path, token: "test", query: ["v":"2"])
        XCTAssertEqual(CacheProtocol.count, 2)
    }
    func testPermissionDenialRemovesCachedPage() async throws {
        let c = try client(); _ = try await c.servers(token: "test")
        CacheProtocol.status = 403
        do { _ = try await c.servers(token: "test"); XCTFail() } catch {}
        let cached: [Resource]? = await c.cached(["servers"])
        XCTAssertNil(cached)
    }
    func testInvalidationPreventsLateDownloadsFromRepopulatingDisk() async throws {
        let c = try client()
        let task = Task { try await c.bytes(["channels","channel","media","portrait"], token:"test") }
        while CacheProtocol.count == 0 { try await Task.sleep(for:.milliseconds(5)) }
        c.assets?.invalidate()
        _ = try await task.value
        XCTAssertFalse(FileManager.default.fileExists(atPath:directory.appendingPathComponent("one/assets").path))
    }
    func testMigrationGenerationAndSensitiveEndpoints() throws {
        let old = directory.appendingPathComponent("old"), next = directory.appendingPathComponent("new")
        AssetDiskCache(directory:old).put("image",Data([1,2]))
        let store = AssetDiskCache(directory:next,legacyDirectory:old)
        XCTAssertEqual(store.get("image"),Data([1,2])); XCTAssertFalse(FileManager.default.fileExists(atPath:old.path))
        let earlier = store.reserve("ordered"), later = store.reserve("ordered")
        store.put("ordered", Data([2]), ticket:later); store.put("ordered", Data([1]), ticket:earlier)
        XCTAssertEqual(store.get("ordered"),Data([2]))
        let revision = store.generation; store.clear(); store.put("late",Data([3]),generation:revision)
        XCTAssertNil(store.get("late"))
        XCTAssertFalse(ReadCachePolicy.keep(["auth","me"]))
        XCTAssertFalse(ReadCachePolicy.keep(["auth","login"]))
        XCTAssertFalse(AssetDiskCache.keepable("immutable, no-store"))
    }
}
private final class CacheProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var calls = 0
    private static var responseStatus = 200
    static var count: Int { lock.lock(); defer { lock.unlock() }; return calls }
    static var status: Int { get { lock.lock(); defer { lock.unlock() }; return responseStatus } set { lock.lock(); responseStatus = newValue; lock.unlock() } }
    static func reset() { lock.lock(); calls = 0; responseStatus = 200; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "cache.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.calls += 1; let status = Self.responseStatus; Self.lock.unlock()
        let body = status != 200 ? #"{"error":"forbidden"}"# : request.url?.lastPathComponent == "servers" ? #"[{"id":"server","name":"Cached"}]"# : "image"
        DispatchQueue.global().asyncAfter(deadline:.now() + 0.1) { [self] in
            client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:["Cache-Control":"private, max-age=31536000, immutable"])!,cacheStoragePolicy:.notAllowed)
            client?.urlProtocol(self,didLoad:Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
