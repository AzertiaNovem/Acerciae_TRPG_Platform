import XCTest
@testable import AcerciaeCore
final class PointBuyTests: XCTestCase {
    private func fixture() throws -> JSONValue {
        var directory = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { directory.deleteLastPathComponent() }
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: directory.appendingPathComponent("contracts/fixtures/point-buy.json")))
    }
    func testBudgetsBasesAndSkillEligibility() throws {
        let f = try fixture(); let p = PointBuy(card: f["card"], rules: f["rules"])
        XCTAssertEqual(p.characteristicTotal, 475); XCTAssertEqual(p.careerBudget, 230); XCTAssertEqual(p.hobbyBudget, 130)
        XCTAssertEqual(p.base("Dodge"), 27); XCTAssertEqual(p.base("Language (Own)"), 60)
        XCTAssertEqual(p.base("Fighting (Sword)"), 20); XCTAssertEqual(p.base("Science (Biology)"), 1)
        XCTAssertEqual(p.base("Language (Other) (Latin)"), 1)
        XCTAssertEqual(p.total("Listen"), 62); XCTAssertEqual(p.spent("career"), 40)
        XCTAssertFalse(p.allowed("Fighting (Sword)")); XCTAssertTrue(p.allowed("Spot Hidden")); XCTAssertFalse(p.allowed("Dodge"))
        XCTAssertNil(p.creditWarning)
    }
    func testRuleViolationsAndWarnings() throws {
        let f = try fixture()
        for item in f["cases"].array { XCTAssertEqual(PointBuy(card: item["card"], rules: f["rules"]).issues.count, item["issues"].int, item["name"].text) }
        var card = f["card"].object; card["skill_points"] = .object([:])
        let p = PointBuy(card: .object(card), rules: f["rules"])
        XCTAssertNotNil(p.creditWarning); XCTAssertTrue(p.issues.isEmpty)
    }
    func testLivePointBuyRoundTripAndServerValidation() async throws {
        guard let base = ProcessInfo.processInfo.environment["ACERCIAE_POINTS_BASE"] else { throw XCTSkip("Set ACERCIAE_POINTS_BASE to the dedicated point-buy test service") }
        let address = try BackendAddress(base, allowLocalHTTP: true)
        XCTAssertTrue(["localhost", "127.0.0.1"].contains(address.url.host ?? ""))
        let api = BackendClient(address: address)
        let health = try await api.health(); XCTAssertEqual(health.llmMode, "mock")
        let gm = try await api.login(username: "keeper", password: "password")
        let alice = try await api.login(username: "alice", password: "password")
        let servers = try await api.servers(token: gm.token); let server = try XCTUnwrap(servers.first)
        let channels = try await api.channels(token: gm.token, server: server.id); let channel = try XCTUnwrap(channels.first)
        let serverPath = ["servers", server.id, "settings"]
        _ = try await api.resource(serverPath, token: gm.token, body: .object(["features": .object(["coc7_points": .bool(true)])]), method: "PUT")
        let rules = try await api.resource(["coc7", "rules"], token: alice.token)
        XCTAssertEqual(rules["careers"].array.count, 230)
        let chars: [Resource] = try await api.request(["channels", channel.id, "characters"], token: alice.token)
        let own = try XCTUnwrap(chars.first { $0["user_id"].text == alice.user.id })
        let path = ["channels", channel.id, "characters", own.id]
        var card = try fixture()["card"].object
        card["career"] = .object(["name": .string("会计师"), "choices": .array([]), "specialties": .array([.string("Science")])])
        card["skill_points"] = .object(["Listen": .object(["career": .number(30), "hobby": .number(10), "growth": .number(2)]), "Science (Biology)": .object(["career": .number(20)]), "Credit Rating": .object(["career": .number(30)])])
        let preview = PointBuy(card: .object(card), rules: rules)
        let saved = try await api.resource(path + ["card"], token: alice.token, body: .object(["role_card": .object(card)]), method: "PUT")
        XCTAssertTrue(saved["points"]["enabled"].bool)
        XCTAssertEqual(saved["points"]["career_budget"].int, preview.careerBudget)
        XCTAssertEqual(saved["points"]["hobby_budget"].int, preview.hobbyBudget)
        XCTAssertEqual(saved["points"]["career_spent"].int, preview.spent("career"))
        for name in ["Listen", "Science (Biology)", "Credit Rating"] { XCTAssertEqual(saved["character"]["role_card"]["skills"][name].int, preview.total(name)) }
        card["skill_points"] = .object(["Dodge": .object(["career": .number(10)])])
        do {
            _ = try await api.resource(path + ["card"], token: alice.token, body: .object(["role_card": .object(card)]), method: "PUT")
            XCTFail("Disallowed career points must be rejected")
        } catch ClientError.pointsRule(let message) { XCTAssertTrue(message.contains("Dodge")) }
        let after = try await api.resource(path + ["space"], token: alice.token)
        XCTAssertEqual(after["character"]["role_card"], saved["character"]["role_card"], "Rejected saves must not mutate the card")
        _ = try await api.resource(serverPath, token: gm.token, body: .object(["features": .object(["coc7_points": .bool(false)])]), method: "PUT")
        let off = try await api.resource(path + ["space"], token: alice.token)
        XCTAssertFalse(off["points"]["enabled"].bool)
        XCTAssertEqual(off["character"]["role_card"]["skill_points"], saved["character"]["role_card"]["skill_points"])
        _ = try await api.resource(serverPath, token: gm.token, body: .object(["features": .object(["coc7_points": .bool(true)])]), method: "PUT")
        for token in [gm.token, alice.token] { _ = try await api.resource(["auth", "logout"], token: token, body: .object([:])) }
    }

}
