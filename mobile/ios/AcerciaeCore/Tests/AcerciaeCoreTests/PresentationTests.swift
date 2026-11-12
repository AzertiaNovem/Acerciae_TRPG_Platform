import XCTest
@testable import AcerciaeCore

final class PresentationTests: XCTestCase {
    func testAvatarMetadataDecodesWithoutBreakingLegacyMessages() throws {
        let message = try APIJSON.decoder().decode(Message.self, from: Data(#"{"id":"m","content":"hello","author_name":"A","kind":"ic","seq":1,"character_id":"c","character_avatar_asset_id":"a","character_avatar_version":4,"author_avatar_version":2}"#.utf8))
        XCTAssertEqual(message.characterId, "c")
        XCTAssertEqual(message.characterAvatarAssetId, "a")
        XCTAssertEqual(message.characterAvatarVersion, 4)
        XCTAssertEqual(message.authorAvatarVersion, 2)
        let user = try APIJSON.decoder().decode(User.self, from: Data(#"{"id":"u","username":"u","display_name":"A","avatar_data":"data:image/png;base64,eA==","avatar_version":3}"#.utf8))
        XCTAssertEqual(user.avatarVersion, 3)
        XCTAssertTrue(user.avatarData?.hasPrefix("data:image/png") == true)
    }
    func testDiceTonesAndHiddenNotice() throws {
        func message(_ dice: String) throws -> Message {
            try APIJSON.decoder().decode(Message.self, from: Data((#"{"id":"m","content":".rh 1d100","author_name":"A","kind":"roll","seq":1,"dice": "# + dice + "}").utf8))
        }
        for (payload, tone) in [(#"{"level":"critical"}"#, DiceTone.critical), (#"{"level":"fumble"}"#, .fumble), (#"{"success":true}"#, .success), (#"{"success":false}"#, .failure), (#"{"rolls":[{"level":"critical"},{"success":false}]}"#, .failure), (#"{"success":true,"rolls":[{"success":false}]}"#, .success)] {
            let m = try message(payload)
            XCTAssertEqual(m.diceTone, tone)
            XCTAssertEqual(m.diceCommand, ".rh 1d100")
        }
        let hidden = try message(#"{"type":"hidden_notice","text":"A made a hidden roll."}"#)
        XCTAssertEqual(hidden.diceTone, .notice)
        XCTAssertNil(hidden.diceCommand)
        XCTAssertEqual(hidden.displayText, "A made a hidden roll.")
        XCTAssertEqual(try message(#"{"type":"hidden_notice"}"#).displayText, "")
    }
    private func roll(_ dice: String) throws -> Message {
        try APIJSON.decoder().decode(Message.self, from: Data((#"{"id":"m","content":".ra x","author_name":"A","kind":"roll","seq":1,"dice": "# + dice + "}").utf8))
    }
    func testEveryOutcomeHasItsToneAndRepeatedChecksColourEachLine() throws {
        for (level, tone) in [("critical", DiceTone.critical), ("extreme", .extreme), ("hard", .hard), ("regular", .success), ("failure", .failure), ("fumble", .fumble)] {
            XCTAssertEqual(try roll(#"{"type":"check","rolls":[{"level":""# + level + #""}]}"#).diceTone, tone)
        }
        XCTAssertEqual(try roll(#"{"type":"roll","text":"2d6=8","rolls":[{"total":8}]}"#).diceTone, .roll)
        XCTAssertEqual(try roll(#"{"type":"st","text":"STR 50"}"#).diceTone, .neutral)
        let repeated = try roll(#"{"type":"check","text":"one\ntwo\nthree","rolls":[{"level":"hard"},{"level":"fumble"},{"level":"regular"}]}"#)
        XCTAssertEqual(repeated.diceLines.map(\.text), ["one", "two", "three"])
        XCTAssertEqual(repeated.diceLines.map(\.tone), [.hard, .fumble, .success])
        XCTAssertEqual(try roll(#"{"type":"check","text":"only","rolls":[{"level":"critical"}]}"#).diceLines.map(\.tone), [.critical])
        let line = "D100=96/99, 3d6=[6+4]=14"
        XCTAssertEqual(DiceDisplay.numberRanges(in: line).map { String(line[$0]) }, ["96", "99", "6", "4", "14"])
    }
    func testDicePersonaAndDisplayPreference() throws {
        XCTAssertEqual(try roll(#"{"type":"roll","text":"x","bot":{"name":"Madame Fortune","group_id":"g1","avatar_version":2}}"#).diceBot, DiceBot(name: "Madame Fortune", groupId: "g1", avatarVersion: 2))
        XCTAssertNil(try roll(#"{"type":"roll","text":"x"}"#).diceBot)
        func user(_ display: String?) throws -> User {
            try APIJSON.decoder().decode(User.self, from: Data((#"{"id":"u","username":"u","display_name":"A""# + (display.map { #","dice_display":""# + $0 + #"""# } ?? "") + "}").utf8))
        }
        XCTAssertTrue(DiceDisplay.isSeparate(try user(nil)))
        XCTAssertTrue(DiceDisplay.isSeparate(try user("separate")))
        XCTAssertFalse(DiceDisplay.isSeparate(try user("inline")))
        XCTAssertTrue(DiceDisplay.isSeparate(nil))
    }
    func testPackagedLanguagesAndContentBoundary() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("App/Localization/mobile-localizations.json")
        let catalog = try JSONDecoder().decode(TranslationCatalog.self, from: Data(contentsOf: file))
        XCTAssertEqual(InterfaceLanguage.codes.count, 11)
        XCTAssertEqual(InterfaceLanguage.supported("zh-Hant-HK"), "zh-TW")
        XCTAssertEqual(InterfaceLanguage.supported("ja-JP"), "ja")
        XCTAssertEqual(InterfaceLanguage.supported("xx"), "en")
        for translations in catalog.catalog.values { XCTAssertEqual(translations.count, 10); XCTAssertFalse(translations.contains("")) }
        XCTAssertEqual(catalog.text("角色主页", language: "en"), "Character home")
        XCTAssertEqual(catalog.text("角色主页", language: "zh-CN"), "角色主页")
        XCTAssertNotEqual(catalog.text("角色主页", language: "ja"), "角色主页")
        for code in InterfaceLanguage.codes { XCTAssertEqual(catalog.text("调查员自定义台词 9d8", language: code), "调查员自定义台词 9d8") }
    }
}
