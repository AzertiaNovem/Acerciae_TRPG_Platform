import XCTest
@testable import AcerciaeCore

final class CommitSyncTests: XCTestCase {
    private func json(_ s: String) throws -> JSONValue { try APIJSON.decoder().decode(JSONValue.self, from: Data(s.utf8)) }
    func testChannelSwitchesCannotOverrideServerAndOldChannelsRemainCompatible() throws {
        let server = try json(#"{"features":{"consistency":true,"inspiration":true,"atmosphere":true,"dice":true}}"#)
        for feature in ["consistency", "inspiration", "atmosphere"] {
            XCTAssertTrue(FeatureAccess.enabled(feature, server: server, channel: .object([:])))
            XCTAssertFalse(FeatureAccess.enabled(feature, server: server, channel: .object([feature + "_enabled": .bool(false)])))
            XCTAssertFalse(FeatureAccess.enabled(feature, server: .object([:]), channel: .object([feature + "_enabled": .bool(true)])))
        }
        XCTAssertTrue(FeatureAccess.enabled("dice", server: server, channel: try json(#"{"ai_enabled":false,"dice_enabled":false}"#)))
    }
    func testObjectStoreAvatarAndOlderSessionRoundTrip() throws {
        for value in [#"{"id":"u","username":"test","display_name":"Test","has_avatar":true,"avatar_data":"","avatar_version":3}"#, #"{"id":"u","username":"test","display_name":"Test"}"#] {
            let user = try APIJSON.decoder().decode(User.self, from: Data(value.utf8))
            let data = try JSONEncoder().encode(Session(token: "test-only", user: user))
            XCTAssertEqual(try APIJSON.decoder().decode(Session.self, from: data).user.hasAvatar, user.hasAvatar)
        }
    }
    func testAsyncImportUsesAuthenticatedMultipartAndAcceptsQueuedReceipt() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ImportProtocol.self]
        let client = BackendClient(address: try BackendAddress("https://example.test"), session: URLSession(configuration: config))
        let result = try await client.uploadModule(channel: "ch", title: "Test module", data: Data("%PDF-test".utf8), token: "test-only")
        XCTAssertEqual(result["import_stage"].text, "queued")
        XCTAssertNotEqual(result["status"].text, "ready")
    }
}
private final class ImportProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.url?.path, "/api/channels/ch/modules")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-only")
        XCTAssertTrue(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
        XCTAssertGreaterThanOrEqual(request.timeoutInterval, 120)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"id":"module","status":"uploaded","import_stage":"queued"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
