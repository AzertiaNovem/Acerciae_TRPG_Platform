import XCTest
@testable import AcerciaeCore

final class LiveContractTests: XCTestCase {
    func testLosslessDiceAndResourceKeys() throws {
        let data = Data(#"{"id":"m","content":".rh 1d100","author_name":"Alice","author_id":"a","kind":"roll","seq":4,"dice":{"text":"secret result","hidden":true,"future_key":{"raw_rolls":[42]}}}"#.utf8)
        let message = try APIJSON.decoder().decode(Message.self, from: data)
        XCTAssertEqual(message.authorId, "a")
        XCTAssertEqual(message.displayText, "secret result")
        XCTAssertEqual(message.dice?["future_key"]["raw_rolls"].array.first?.int, 42)
        let resource = try APIJSON.decoder().decode(Resource.self, from: Data(#"{"id":"c","my_role":"gm","features":{"dice":true}}"#.utf8))
        XCTAssertEqual(resource["my_role"].text, "gm")
        XCTAssertTrue(resource["features"]["dice"].bool)
        let notice = try APIJSON.decoder().decode(Message.self, from: Data(#"{"id":"n","content":"hidden roll","author_name":"Alice","kind":"roll","seq":5,"dice":{"type":"hidden_notice"}}"#.utf8))
        XCTAssertEqual(notice.displayText, "")
    }
    func testLocalLiveClient() async throws {
        guard let base = ProcessInfo.processInfo.environment["ACERCIAE_TEST_BASE"] else { throw XCTSkip("Set ACERCIAE_TEST_BASE to a dedicated seeded local test backend") }
        let api = BackendClient(address: try BackendAddress(base, allowLocalHTTP: true))
        let health = try await api.health(); XCTAssertEqual(health.llmMode, "mock")
        let auth = try await api.login(username: "alice", password: "password")
        let servers = try await api.servers(token: auth.token)
        let server = try XCTUnwrap(servers.first)
        let channels = try await api.channels(token: auth.token, server: server.id)
        let channel = try XCTUnwrap(channels.first)
        let windows = try await api.windows(token: auth.token, channel: channel.id)
        XCTAssertFalse(windows.contains { $0.kind == "private" })
        let window = try XCTUnwrap(windows.first)
        let chars: [Resource] = try await api.request(["channels", channel.id, "characters"], token: auth.token)
        XCTAssertFalse(chars.contains { $0["kind"].text == "npc" })
        let mine = try XCTUnwrap(chars.first { $0["user_id"].text == auth.user.id })
        let before = try await api.messages(token: auth.token, channel: channel.id, window: window.id)
        let preview = try await api.resource(["channels", channel.id, "dice", "preview"], token: auth.token, body: .object(["content": .string(".ra 侦查 55"), "chat_window_id": .string(window.id), "character_id": .string(mine.id)]))
        XCTAssertFalse(preview["hint"].text.isEmpty)
        let after = try await api.messages(token: auth.token, channel: channel.id, window: window.id)
        XCTAssertEqual(before.map(\.id), after.map(\.id), "Preview must not roll or post")
        let reminders: [Resource] = try await api.request(["channels", channel.id, "reminders"], token: auth.token)
        XCTAssertTrue(reminders.allSatisfy { !$0.id.isEmpty })
        let settings = try await api.resource(["servers", server.id, "settings"], token: auth.token)
        XCTAssertFalse(settings["is_maintainer"].bool)
        do {
            _ = try await api.resource(["servers", server.id, "settings"], token: auth.token, body: .object(["language": .string("zh")]), method: "PUT")
            XCTFail("Player must not change server settings")
        } catch ClientError.http(let status) { XCTAssertEqual(status, 403) }
        let log = try await api.resource(["channels", channel.id, "studio", "log"], token: auth.token)
        XCTAssertFalse(log["project"]["id"].text.isEmpty)
        let space = try await api.resource(["channels", channel.id, "characters", mine.id, "space"], token: auth.token)
        XCTAssertTrue(space["character"]["editable"].bool)
        let png = try XCTUnwrap(Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII="))
        let uploaded = try await api.uploadCharacterAsset(channel: channel.id, character: mine.id, slot: "avatar", subtitle: "", data: png, token: auth.token)
        XCTAssertFalse(uploaded["avatar"]["id"].text.isEmpty)
        let imageBytes = try await api.bytes(["channels", channel.id, "media", uploaded["avatar"]["id"].text], token: auth.token)
        XCTAssertEqual(imageBytes, png)
        _ = try await api.resource(["auth", "logout"], token: auth.token, body: .object([:]))
    }
}
