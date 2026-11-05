import XCTest
@testable import AcerciaeCore

final class ContractTests: XCTestCase {
    func testMessageReferencesSurviveOfflineRoundTripAndOlderMessages() throws {
        let data = Data(#"{"id":"reply","content":"Reply","author_name":"Player","kind":"ooc","seq":3,"reference_ids":["first","second"]}"#.utf8)
        let message = try APIJSON.decoder().decode(Message.self, from: data)
        XCTAssertEqual(message.referenceIds, ["first", "second"])
        let stored = try JSONEncoder().encode(message)
        XCTAssertEqual(try APIJSON.decoder().decode(Message.self, from: stored).referenceIds, message.referenceIds)
        let older = Data(#"{"id":"old","content":"Original","author_name":"Player","kind":"ooc","seq":1}"#.utf8)
        XCTAssertNil(try APIJSON.decoder().decode(Message.self, from: older).referenceIds)
    }
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
