import XCTest
@testable import AcerciaeCore

final class PassivePresenceTests: XCTestCase {
    func testOptionalStandInAndPassiveFieldsSurviveDecoding() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/passive-presence.json")))
        let message = try APIJSON.decoder().decode(Message.self, from: Data(fixture["message"].pretty.utf8))
        let old = try APIJSON.decoder().decode(Message.self, from: Data(fixture["legacy_message"].pretty.utf8))
        XCTAssertEqual(message.standIn, true)
        XCTAssertNil(message.recallSecondsLeft)
        XCTAssertNil(old.standIn)
        let character = try APIJSON.decoder().decode(Resource.self, from: Data(fixture["character"].pretty.utf8))
        XCTAssertEqual(character["passive_since"].string, "2026-11-12T10:00:00Z")
        XCTAssertEqual(character["user_id"].string, "alice")
    }
}
