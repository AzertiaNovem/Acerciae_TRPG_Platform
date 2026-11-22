import XCTest
@testable import AcerciaeCore

/// Bots: a bot's line and a character a bot plays carry the flag the "bot" tag reads; older servers send neither.
final class BotTagTests: XCTestCase {
    func testBotFlagsSurviveDecoding() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/bots.json")))
        let message = try APIJSON.decoder().decode(Message.self, from: Data(fixture["message"].pretty.utf8))
        let old = try APIJSON.decoder().decode(Message.self, from: Data(fixture["legacy_message"].pretty.utf8))
        XCTAssertEqual(message.authorIsBot, true)
        XCTAssertNil(old.authorIsBot)
        let character = try APIJSON.decoder().decode(Resource.self, from: Data(fixture["character"].pretty.utf8))
        XCTAssertTrue(character["player_is_bot"].bool)
        let legacy = try APIJSON.decoder().decode(Resource.self, from: Data(fixture["legacy_character"].pretty.utf8))
        XCTAssertFalse(legacy["player_is_bot"].bool)
    }
}
