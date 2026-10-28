import XCTest
@testable import AcerciaeCore

final class SessionAndCreationTests: XCTestCase {
    func testSavedSessionCannotOverrideCompiledServer() {
        XCTAssertTrue(ServiceConfiguration.acceptsSavedEndpoint(ServiceConfiguration.backendRoot + "/"))
        XCTAssertFalse(ServiceConfiguration.acceptsSavedEndpoint("http://localhost:18083"))
        XCTAssertFalse(ServiceConfiguration.acceptsSavedEndpoint("https://another.example"))
    }
    func testLocalRegistrationReturnsSessionAndRejectsDuplicate() async throws {
        guard let base = ProcessInfo.processInfo.environment["ACERCIAE_POINTS_BASE"] else { throw XCTSkip("Requires local mock service") }
        let address = try BackendAddress(base, allowLocalHTTP: true)
        guard ["localhost", "127.0.0.1"].contains(address.url.host ?? "") else { throw XCTSkip("Local test service only") }
        let api = BackendClient(address: address)
        let health = try await api.health(); XCTAssertEqual(health.llmMode, "mock")
        let username = "mobile_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(20)
        let session = try await api.register(username: username, password: "local-test-password", displayName: "手机注册测试")
        XCTAssertFalse(session.token.isEmpty)
        let user: User = try await api.request(["auth", "me"], token: session.token)
        XCTAssertEqual(user.username, username)
        XCTAssertEqual(user.displayName, "手机注册测试")
        do {
            _ = try await api.register(username: username, password: "local-test-password", displayName: "")
            XCTFail("Duplicate usernames must be rejected")
        } catch ClientError.http(let status) { XCTAssertEqual(status, 409) }
        for code in InterfaceLanguage.codes {
            let updated = try await api.resource(["auth", "me"], token: session.token, body: .object(["ui_language": .string(code)]), method: "PUT")
            XCTAssertEqual(updated["ui_language"].text, code)
            XCTAssertEqual(updated["display_name"].text, user.displayName)
            let fetched: User = try await api.request(["auth", "me"], token: session.token)
            XCTAssertEqual(fetched.uiLanguage, code)
        }
        let servers = try await api.servers(token: session.token)
        XCTAssertTrue(servers.isEmpty, "New users must not inherit seeded campaign access")
        _ = try await api.resource(["auth", "logout"], token: session.token, body: .object([:]))
    }
    func testSessionStorageRoundTripDoesNotRequirePassword() throws {
        let auth = try APIJSON.decoder().decode(Session.self, from: Data(#"{"token":"test-token","user":{"id":"1","username":"alice","display_name":"艾丽丝"}}"#.utf8))
        let data = try JSONEncoder().encode(auth)
        let restored = try JSONDecoder().decode(Session.self, from: data)
        XCTAssertEqual(restored.token, auth.token)
        XCTAssertEqual(restored.user.displayName, "艾丽丝")
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("password"))
        XCTAssertFalse(String(describing: restored).contains("test-token"))
    }

    func testLiveCreationKeeperPermissionsAndRevokedSession() async throws {
        guard let base = ProcessInfo.processInfo.environment["ACERCIAE_POINTS_BASE"] else { throw XCTSkip("Requires dedicated local mock backend") }
        let address = try BackendAddress(base, allowLocalHTTP: true)
        guard ["localhost", "127.0.0.1"].contains(address.url.host ?? "") else { throw XCTSkip("Local test service only") }
        let api = BackendClient(address: address)
        let health = try await api.health(); XCTAssertEqual(health.llmMode, "mock")
        let alice = try await api.login(username: "alice", password: "password")
        let bob = try await api.login(username: "bob", password: "password")
        let restored = try JSONDecoder().decode(Session.self, from: JSONEncoder().encode(alice))
        let me: User = try await api.request(["auth", "me"], token: restored.token)
        XCTAssertEqual(me.id, alice.user.id)
        let servers = try await api.servers(token: alice.token)
        let server = try XCTUnwrap(servers.first)
        let c = try await api.resource(["servers", server.id, "channels"], token: alice.token, body: .object([
            "name": .string("Mobile creation test " + UUID().uuidString.prefix(8)), "knowledge_mode": .string("isolated")]))
        let path = ["channels", c["id"].text]
        XCTAssertEqual(c["my_role"].text, "gm")
        let windows = try await api.windows(token: alice.token, channel: c["id"].text)
        XCTAssertEqual(windows.first?.kind, "main")
        _ = try await api.resource(path + ["members"], token: alice.token, body: .object(["username": .string("bob"), "role": .string("player")]))
        let npc = try await api.resource(path + ["characters"], token: alice.token, body: .object(["name": .string("Keeper NPC"), "kind": .string("npc")]))
        let pc = try await api.resource(path + ["characters"], token: bob.token, body: .object(["name": .string("Mobile investigator"), "kind": .string("pc")]))
        XCTAssertEqual(pc["user_id"].text, bob.user.id)
        let card: JSONValue = .object(["career": .object(["name": .string("会计师"), "choices": .array([]), "specialties": .array([.string("Science")])]), "characteristics": .object(["EDU": .number(60), "INT": .number(60)]), "skill_points": .object([:])])
        let edited = try await api.resource(path + ["characters", pc["id"].text, "card"], token: bob.token, body: .object([
            "name": .string("Edited investigator"), "bio": .string("A mobile-created character"), "speaking_style": .string("Quiet"), "role_card": card]), method: "PUT")
        XCTAssertEqual(edited["character"]["name"].text, "Edited investigator")
        XCTAssertEqual(edited["character"]["speaking_style"].text, "Quiet")
        let settings: JSONValue = .object(["name": .string("Mobile keeper settings"), "description": .string("Updated"), "era": .string("1920s"), "knowledge_mode": .string("public"), "dice_text_group": .string("builtin:zh"), "ai_enabled": .bool(false), "auto_scenarios": .bool(false), "studio_visible": .bool(false)])
        let updated = try await api.resource(path, token: alice.token, body: settings, method: "PUT")
        XCTAssertEqual(updated["era"].text, "1920s")
        XCTAssertEqual(updated["knowledge_mode"].text, "public")
        XCTAssertFalse(updated["studio_visible"].bool)
        do {
            _ = try await api.resource(path, token: bob.token, body: settings, method: "PUT")
            XCTFail("A player must not change keeper settings")
        } catch ClientError.http(let status) { XCTAssertEqual(status, 403) }
        do {
            _ = try await api.resource(path + ["characters"], token: bob.token, body: .object(["name": .string("Forbidden NPC"), "kind": .string("npc")]))
            XCTFail("A player must not create NPCs")
        } catch ClientError.http(let status) { XCTAssertEqual(status, 403) }
        let visible: [Resource] = try await api.request(path + ["characters"], token: bob.token)
        XCTAssertFalse(visible.contains { $0.id == npc["id"].text })
        XCTAssertTrue(visible.contains { $0.id == pc["id"].text })
        _ = try await api.resource(["auth", "logout"], token: alice.token, body: .object([:]))
        do {
            let _: User = try await api.request(["auth", "me"], token: restored.token)
            XCTFail("Saved tokens must stop working after logout")
        } catch ClientError.http(let status) { XCTAssertEqual(status, 401) }
        _ = try await api.resource(["auth", "logout"], token: bob.token, body: .object([:]))
    }
}
