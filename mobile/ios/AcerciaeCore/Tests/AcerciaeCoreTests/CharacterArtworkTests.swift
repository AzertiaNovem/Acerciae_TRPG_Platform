import XCTest
@testable import AcerciaeCore

final class CharacterArtworkTests: XCTestCase {
    private let character = #"{"id":"hero","name":"Hero","updated_at":"2026-11-03T12:00:00Z","avatar_asset_id":"avatar","avatar_asset_version":7,"avatar_asset_hash":"avatar-hash"}"#
    private func rows() throws -> [Resource] { try JSONDecoder().decode([Resource].self, from: Data("[\(character)]".utf8)) }
    private func client(_ directory: URL) throws -> BackendClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ArtworkProtocol.self]
        return BackendClient(address: try BackendAddress("https://artwork.test"), session: URLSession(configuration: config), assets: AssetDiskCache(directory: directory))
    }
    override func setUp() { ArtworkProtocol.reset() }

    func testAvatarUsesImageVersionAndNeverMixesOldMessageMetadata() throws {
        let message = try APIJSON.decoder().decode(Message.self, from: Data(#"{"id":"m","content":"hello","author_name":"Player","kind":"ic","seq":1,"character_avatar_asset_id":"old","character_avatar_version":2,"character_avatar_hash":"old-hash"}"#.utf8))
        let avatar = try XCTUnwrap(CharacterArtwork.avatar(character: rows()[0], message: message))
        XCTAssertEqual(avatar.id, "avatar"); XCTAssertEqual(avatar.query, ["v":"7"]); XCTAssertEqual(avatar.hash, "avatar-hash")
        XCTAssertEqual(CharacterArtwork.avatar(character: nil, message: message)?.query, ["v":"2"])
    }

    func testPreloadsAllSlotsAndRestartReadsDiskByHashWithoutDownloadingAgain() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let api = try client(dir), rows = try rows()
        let worker = CharacterArtworkPrefetcher()
        await worker.warm(channel: "c", characters: rows, client: api, token: "fixture")
        XCTAssertEqual(ArtworkProtocol.paths, ["/api/channels/c/media/avatar?v=7", "/api/channels/c/characters/hero/space", "/api/channels/c/media/portrait?v=3", "/api/channels/c/media/smile?v=4"])
        await worker.warm(channel: "c", characters: rows, client: api, token: "fixture")
        XCTAssertEqual(ArtworkProtocol.paths.count, 4, "Repeated metadata refresh must not refetch the manifest or pictures")
        let restarted = try client(dir)
        await CharacterArtworkPrefetcher().warm(channel: "c", characters: rows, client: restarted, token: "fixture")
        XCTAssertEqual(ArtworkProtocol.paths.count, 5, "Only the manifest is revalidated after restart")
        let data = try await restarted.bytes(["channels","c","media","another-id"], token: "fixture", query: ["v":"10"], hash: "portrait-hash")
        XCTAssertEqual(String(data: data, encoding: .utf8), "pixels:portrait")
        XCTAssertEqual(ArtworkProtocol.paths.count, 5)
        let changed = try JSONDecoder().decode([Resource].self, from: Data("[\(character.replacingOccurrences(of: "avatar-hash", with: "new-hash").replacingOccurrences(of: "version\":7", with: "version\":8"))]".utf8))
        await worker.warm(channel: "c", characters: changed, client: api, token: "fixture")
        XCTAssertTrue(ArtworkProtocol.paths.contains("/api/channels/c/media/avatar?v=8"))
    }

    func testCancellationStopsQueueAndPrivateResponsesStayOffDisk() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        ArtworkProtocol.delay = 0.2
        let api = try client(dir), rows = try rows(), worker = CharacterArtworkPrefetcher()
        let task = Task { await worker.warm(channel: "c", characters: rows, client: api, token: "fixture") }
        while ArtworkProtocol.paths.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        task.cancel(); await task.value
        XCTAssertEqual(ArtworkProtocol.paths.count, 1, "Cancel must not start manifests or further transfers")
        ArtworkProtocol.reset(); ArtworkProtocol.privatePictures = true
        api.assets?.clear()
        await CharacterArtworkPrefetcher().warm(channel: "c", characters: rows, client: api, token: "fixture")
        XCTAssertNil(api.assets?.get("sha:avatar-hash")); XCTAssertNil(api.assets?.get("sha:portrait-hash"))
    }
}

private final class ArtworkProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var requests: [String] = []
    static var delay: Double = 0
    static var privatePictures = false
    static var paths: [String] { lock.lock(); defer { lock.unlock() }; return requests }
    static func reset() { lock.lock(); defer { lock.unlock() }; requests = []; delay = 0; privatePictures = false }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "artwork.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!, name = url.lastPathComponent
        Self.lock.lock(); Self.requests.append(url.path + (url.query.map { "?" + $0 } ?? "")); Self.lock.unlock()
        let body = name == "space" ? #"{"avatar":{"id":"avatar","version":7,"hash":"avatar-hash"},"portrait":{"id":"portrait","version":3,"hash":"portrait-hash"},"subtitles":[{"id":"smile","version":4,"hash":"smile-hash"},{"id":"same-portrait","version":1,"hash":"portrait-hash"}]}"# : "pixels:" + name
        let cacheControl = Self.privatePictures ? "private, max-age=600" : "private, immutable"
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.delay) { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type":"application/json", "Cache-Control":cacheControl])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
