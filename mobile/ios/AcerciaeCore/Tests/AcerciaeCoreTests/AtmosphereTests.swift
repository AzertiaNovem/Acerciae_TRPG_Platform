import XCTest
@testable import AcerciaeCore
final class AtmosphereTests: XCTestCase {
    func testCompleteSetAndFourDisplayVariants() throws {
        var fields: [String: JSONValue] = [:]
        for variant in Atmosphere.variants { fields[variant] = .string(variant + "-asset") }
        let complete: JSONValue = .object(["enabled": .bool(true), "assets": .object(fields)])
        for dark in [false, true] { for portrait in [false, true] {
            let key = (dark ? "night" : "day") + (portrait ? "_portrait" : "_landscape")
            XCTAssertEqual(Atmosphere.asset(complete, dark: dark, portrait: portrait), key + "-asset")
        } }
        for variant in Atmosphere.variants {
            var partial = fields; partial.removeValue(forKey: variant)
            XCTAssertNil(Atmosphere.asset(.object(["enabled": .bool(true), "assets": .object(partial)]), dark: true, portrait: true))
        }
        XCTAssertNil(Atmosphere.asset(.object(["enabled": .bool(false), "assets": .object(fields)]), dark: true, portrait: true))
        XCTAssertNil(Atmosphere.asset(.object(["enabled": .bool(true)]), dark: true, portrait: true))
    }
    func testOldAccountCompatibilityAndPreferencePersistence() throws {
        let old = try APIJSON.decoder().decode(User.self, from: Data(#"{"id":"u","username":"user","display_name":"User"}"#.utf8))
        XCTAssertNotEqual(old.atmosphereEnabled, true)
        let user = try APIJSON.decoder().decode(User.self, from: Data(#"{"id":"u","username":"user","display_name":"User","atmosphere_enabled":true}"#.utf8))
        let session = Session(token: "test-only", user: user)
        let restored = try JSONDecoder().decode(Session.self, from: JSONEncoder().encode(session))
        XCTAssertEqual(restored.user.atmosphereEnabled, true)
    }
    func testLivePreviewUsesDedicatedAuthorizedEndpoint() async throws {
        guard let base = ProcessInfo.processInfo.environment["ACERCIAE_ATMOSPHERE_BASE"] else { throw XCTSkip("Set a local atmosphere fixture service") }
        let address = try BackendAddress(base, allowLocalHTTP: true)
        XCTAssertTrue(["localhost", "127.0.0.1"].contains(address.url.host ?? ""))
        let client = BackendClient(address: address)
        let auth = try await client.login(username: "keeper", password: "password")
        let servers = try await client.servers(token: auth.token)
        let server = try XCTUnwrap(servers.first { $0.name == "Mobile atmosphere preview" })
        let channels = try await client.channels(token: auth.token, server: server.id)
        let channel = try XCTUnwrap(channels.first)
        let root = ["channels", channel.id, "atmosphere"]
        let current = try await client.resource(root, token: auth.token)
        XCTAssertTrue(current["enabled"].bool); XCTAssertTrue(current["mock"].bool)
        for key in Atmosphere.variants {
            let data = try await client.bytes(root + ["assets", current["assets"][key].text], token: auth.token)
            XCTAssertEqual(Array(data.prefix(8)), [137,80,78,71,13,10,26,10])
            func dimension(_ offset: Int) -> UInt32 { data[offset..<(offset + 4)].reduce(0) { ($0 << 8) | UInt32($1) } }
            XCTAssertEqual(dimension(20) > dimension(16), key.hasSuffix("portrait"))
        }
        let player = try await client.login(username: "alice", password: "password")
        let off = try await client.resource(root, token: player.token)
        XCTAssertFalse(off["enabled"].bool)
        do { _ = try await client.bytes(root + ["assets", current["assets"]["night_portrait"].text], token: player.token); XCTFail("Disabled preference must deny preview") }
        catch ClientError.http(404) { }
        do { _ = try await client.resource(root + ["history"], token: player.token); XCTFail("Players cannot read prompts") }
        catch ClientError.http(403) { }
    }
}
