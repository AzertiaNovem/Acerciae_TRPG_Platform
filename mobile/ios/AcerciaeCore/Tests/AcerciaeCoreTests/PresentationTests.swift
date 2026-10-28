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
