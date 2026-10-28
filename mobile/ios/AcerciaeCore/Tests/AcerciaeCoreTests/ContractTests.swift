import XCTest
@testable import AcerciaeCore

final class ContractTests: XCTestCase {
    func testUnsafeAddressesAreRejected() {
        for url in ["http://example.com", "https://user:password@example.com", "https://example.com/api", "https://example.com?token=secret"] {
            XCTAssertThrowsError(try BackendAddress(url, allowLocalHTTP: true))
        }
        XCTAssertThrowsError(try BackendAddress("http://localhost:8080"))
        XCTAssertNoThrow(try BackendAddress("http://localhost:8080", allowLocalHTTP: true))
    }
    func testEndpointAndWebsocketEncoding() throws {
        let address = try BackendAddress("https://example.com")
        XCTAssertEqual(address.api(["channels", "a/b"]).absoluteString, "https://example.com/api/channels/a%2Fb")
        let socket = address.websocket(.context, token: "a&b=")
        XCTAssertEqual(socket.scheme, "wss")
        XCTAssertEqual(URLComponents(url: socket, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "a&b=")
    }
    func testSharedFixtureReferencesAndDecoding() throws {
        var directory = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { directory.deleteLastPathComponent() }
        let fixture = try DemoCampaign.decode(Data(contentsOf: directory.appendingPathComponent("contracts/fixtures/demo-campaign.json")))
        XCTAssertEqual(fixture.documents.count, 6)
        XCTAssertEqual(Set(fixture.messages.map(\.id)).count, fixture.messages.count)
        for highlight in fixture.highlights {
            XCTAssertTrue(fixture.documents.contains { $0.id == highlight.documentId })
            XCTAssertTrue(highlight.sourceEventIds.allSatisfy { id in fixture.messages.contains { $0.id == id } })
        }
    }
    func testCurrentHealthWithUnknownFields() throws {
        let data = Data(#"{"status":"ok","llm_mode":"mock","db":"ok","new_field":true}"#.utf8)
        XCTAssertEqual(try APIJSON.decoder().decode(Health.self, from: data).llmMode, "mock")
    }
}
