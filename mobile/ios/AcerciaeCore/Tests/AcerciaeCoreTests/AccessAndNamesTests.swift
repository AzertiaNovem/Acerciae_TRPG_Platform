import XCTest
@testable import AcerciaeCore
final class AccessAndNamesTests: XCTestCase {
    private func json(_ s: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }
    func testEveryServerLanguageAndCanonicalKeys() throws {
        var dir = URL(fileURLWithPath: #filePath); for _ in 0..<5 { dir.deleteLastPathComponent() }
        let rules = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: dir.appendingPathComponent("contracts/fixtures/localized-rules.json")))
        for language in InterfaceLanguage.codes {
            let names = RuleNames(rules: rules, language: language)
            for key in ["Accounting", "Dodge", "Science (Biology)", "Language (Other) (Latin)", "Firearms (Bow)"] {
                XCTAssertEqual(names.skillKey(names.skillLabel(key)), key, language)
            }
            let career = rules["careers"].array[0]
            XCTAssertFalse(names.careerLabel(career).isEmpty); XCTAssertFalse(names.careerDescription(career).isEmpty)
            if language != "zh-CN" { XCTAssertNotEqual(names.careerLabel(career), career["name"].text) }
        }
        XCTAssertEqual(RuleNames(rules: rules, language: "zh-CN").skillKey("科学（生物学）"), "Science (生物学)")
    }
    func testAccessMatrixAndMinimalHealth() throws {
        for role in ["owner", "admin", "member", "guest", ""] {
            let policy = try json(#"{"policy":{"channel_creation":"maintainers"}}"#)
            XCTAssertEqual(AccessRules.canCreateChannel(role: role, settings: policy), ["owner", "admin"].contains(role))
        }
        for gm in [true, false] { for ended in [true, false] { for visible in [true, false] { for player in [true, false] {
            let ch: JSONValue = .object(["id": .string("test"), "my_role": .string(gm ? "gm" : "player"), "story_status": .string(ended ? "ended" : "ongoing"), "studio_visible": .bool(visible), "studio_player_access": .bool(player)])
            XCTAssertEqual(AccessRules.studio(ch, .object([:])), ended ? "open" : !visible ? "hidden" : !gm && !player ? "locked" : "open")
            XCTAssertEqual(AccessRules.studio(ch, try json(#"{"features":{"log_studio":false}}"#)), "disabled")
        } } } }
        let health = try JSONDecoder().decode(Health.self, from: Data(#"{"status":"ok"}"#.utf8)); XCTAssertEqual(health.status, "ok")
    }
    func testSpecializationDoesNotOpenOtherSkills() throws {
        let rules = try json(#"{"families":[{"name":"Science","base":1}],"careers":[{"name":"Test","free":1,"fixed":[{"skill":"Science","spec":"Biology"}]}]}"#)
        let card = try json(#"{"career":{"name":"Test","specialties":["",""]}}"#)
        let points = PointBuy(card: card, rules: rules)
        XCTAssertTrue(points.allowed("Science (Biology)")); XCTAssertFalse(points.allowed("Science (Chemistry)")); XCTAssertTrue(points.issues.isEmpty)
        XCTAssertTrue(points.covers(try json(#"{"skill":"Science","any":true}"#), "Science（Chemistry）"))
    }
}
