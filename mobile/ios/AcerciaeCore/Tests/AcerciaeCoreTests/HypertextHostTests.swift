import XCTest
@testable import AcerciaeCore

/// What the iOS app decides around a card (HypertextHost.swift): the viewer in the card's window as HypertextCard.tsx
/// reads them, the pieces of a filled sentence, the lines an action posted, and the engine host's rules.
final class HypertextHostTests: XCTestCase {
    private typealias H = Hypertext

    private func j(_ text: String) -> JSONValue { (try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .string("<bad test JSON>") }
    private func doc(actors: [String]? = nil) throws -> H.Doc {
        var card: [String: JSONValue] = ["v": .number(1), "body": j(#"[{"type":"button","id":"go","label":"Go","on":"go"}]"#), "script": .string("on('go', () => {});")]
        if let actors { card["actors"] = .array(actors.map(JSONValue.string)) }
        return try XCTUnwrap(H.parseDoc(.object(card)))
    }
    private func card(window: String? = "w1", recalled: Bool = false) -> Message {
        var m = Message(id: "card", content: "Go", authorName: "GM", characterName: nil, kind: "hypertext", seq: 3)
        m.chatWindowId = window
        if recalled { m.recalledAt = "2026-11-14T00:00:00Z" }
        return m
    }
    private let window = #"{"id":"w1","members":[{"user_id":"u1","character_id":"ada","character_name":"Ada in w1"},{"user_id":"u2","character_id":null,"visibility_paused":true}]}"#
    private let characters = #"[{"id":"ada","name":"Ada","user_id":"u1"},{"id":"bo","name":"Bo","user_id":"u1"},{"id":"cy","name":"Cy","user_id":"u2"},{"id":"npc","name":"Warden","kind":"npc"}]"#

    func testTheSeatComesFromTheCardsWindow() {
        let w = j(window)
        let ada = H.seat(window: w, userId: "u1")
        XCTAssertTrue(ada.member); XCTAssertFalse(ada.paused); XCTAssertFalse(ada.archived)
        XCTAssertEqual(ada.characterId, "ada"); XCTAssertEqual(ada.characterName, "Ada in w1")
        let paused = H.seat(window: w, userId: "u2")
        XCTAssertTrue(paused.member); XCTAssertTrue(paused.paused); XCTAssertNil(paused.characterId)
        XCTAssertFalse(H.seat(window: w, userId: "u3").member)
        XCTAssertFalse(H.seat(window: w, userId: nil).member, "signed out: nobody")
        XCTAssertFalse(H.seat(window: nil, userId: "u1").member, "a window not in the list")
        XCTAssertTrue(H.seat(window: j(#"{"archived_at":"2026-11-01T00:00:00Z","members":[]}"#), userId: "u1").archived)
        XCTAssertFalse(H.seat(window: j(#"{"archived_at":null,"members":[]}"#), userId: "u1").archived)
    }

    func testTheViewerSpeaksAsTheComposersCharacterAndTheCardFollowsIt() throws {
        let d = try doc(), w = j(window), cs = j(characters).array
        func viewing(_ speakAs: String?, user: String = "u1", gm: Bool = false) -> H.Viewing {
            H.viewing(card(), doc: d, openWindow: "w1", window: w, userId: user, gm: gm, speakAs: speakAs, characters: cs, unavailable: nil, engine: true, dice: true)
        }
        // The window's character: the server takes it, so no character_id is sent.
        var v = viewing(nil)
        XCTAssertNil(v.sayCharacterId); XCTAssertEqual(v.characterName, "Ada"); XCTAssertEqual(v.viewer, H.Viewer(gm: false, actor: true, character: "Ada"))
        XCTAssertEqual(viewing("ada").sayCharacterId, nil)
        // Another character picked under "Speak as": sent, and named in the confirmation and to the script.
        v = viewing("bo")
        XCTAssertEqual(v.sayCharacterId, "bo"); XCTAssertEqual(v.characterName, "Bo"); XCTAssertEqual(v.viewer.character, "Bo")
        // Not cast in the window: the first own character, as the composer does.
        v = viewing("", user: "u2")
        XCTAssertEqual(v.sayCharacterId, "cy"); XCTAssertEqual(v.viewer.character, "Cy"); XCTAssertTrue(v.facts.paused)
        // No character at all: the account speaks (the confirmation names the account).
        v = viewing(nil, user: "u9")
        XCTAssertNil(v.sayCharacterId); XCTAssertNil(v.characterName); XCTAssertFalse(v.facts.member)
        // A GM speaking as an NPC.
        v = viewing("npc", user: "gm", gm: true)
        XCTAssertEqual(v.sayCharacterId, "npc"); XCTAssertEqual(v.viewer, H.Viewer(gm: true, actor: true, character: "Warden"))
        // The window's own name is used when the channel list does not have the character.
        v = H.viewing(card(), doc: d, openWindow: "w1", window: w, userId: "u1", gm: false, speakAs: nil, characters: [], unavailable: nil, engine: true, dice: true)
        XCTAssertEqual(v.characterName, "Ada in w1")
    }

    func testTheFactsGiveEveryLockReasonInTheWebsOrder() throws {
        let w = j(window), cs = j(characters).array
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func reason(_ m: Message, doc d: H.Doc, window: JSONValue? = nil, user: String = "u1", gm: Bool = false, unavailable: H.Unavailable? = nil, loaded: Bool = true) -> H.CardReason? {
            let v = H.viewing(m, doc: d, openWindow: "w1", window: window ?? w, userId: user, gm: gm, speakAs: nil, characters: cs, unavailable: unavailable, engine: true, dice: true, now: now)
            var e = H.CardEntry(channelId: "c"); e.loaded = loaded
            XCTAssertEqual(v.facts.now, now)
            return H.present(d, entry: e, facts: v.facts).reason
        }
        let open = try doc()
        XCTAssertNil(reason(card(), doc: open))
        XCTAssertEqual(reason(card(recalled: true), doc: open), .recalled)
        XCTAssertEqual(reason(card(window: "w0"), doc: open), .history, "a line of an earlier window in a fork")
        XCTAssertEqual(reason(card(window: nil), doc: open), .history)
        XCTAssertEqual(reason(card(), doc: open, unavailable: .missing), .missing)
        XCTAssertEqual(reason(card(), doc: open, window: j(#"{"archived_at":"2026-11-01T00:00:00Z","members":[{"user_id":"u1","character_id":"ada"}]}"#)), .archived)
        XCTAssertEqual(reason(card(), doc: open, user: "u2"), .paused)
        XCTAssertNil(reason(card(), doc: open, user: "gm", gm: true), "a GM needs no seat")
        XCTAssertEqual(reason(card(), doc: open, user: "u3"), .member)
        XCTAssertEqual(reason(card(), doc: try doc(actors: ["Bo"])), .notActor)
        XCTAssertNil(reason(card(), doc: try doc(actors: ["ADA"])), "actors are compared without case")
        XCTAssertEqual(reason(card(), doc: open, loaded: false), .loading)
        XCTAssertEqual(H.present(open, entry: nil, facts: H.spectatorFacts()).reason, .spectator)
    }

    func testSegmentsCutASentenceAtItsPlaceholdersAndIsolateTheValues() {
        XCTAssertEqual(H.segments("Post as {name}: {text}", ["name": "Ada", "text": ".ra Spot"]), [
            H.Segment(text: "Post as ", key: nil), H.Segment(text: "\u{2068}Ada\u{2069}", key: "name"), H.Segment(text: ": ", key: nil),
            H.Segment(text: "\u{2068}.ra Spot\u{2069}", key: "text"),
        ])
        // A translation may move the placeholders; an unknown one stays as written; braces in values are kept.
        XCTAssertEqual(H.segments("{text} — {name} {other}", ["name": "{x}", "text": "t"]), [
            H.Segment(text: "\u{2068}t\u{2069}", key: "text"), H.Segment(text: " — ", key: nil), H.Segment(text: "\u{2068}{x}\u{2069}", key: "name"),
            H.Segment(text: " {other}", key: nil),
        ])
        XCTAssertEqual(H.segments("No placeholder", [:]), [H.Segment(text: "No placeholder", key: nil)])
        XCTAssertEqual(H.segments("", [:]), [])
        // The same reading as fill.
        for s in ["Post as {name}: {text}", "{n}{n}", "a{b", "a{}b{n}", "{na me}", "x}{n}"] {
            XCTAssertEqual(H.segments(s, ["n": "1", "name": "N", "text": "T"]).map(\.text).joined(), H.fill(s, ["n": "1", "name": "N", "text": "T"]), s)
        }
    }

    func testTheLinesAnActionPostedJoinTheOpenWindowOnce() {
        func line(_ id: String, _ seq: Int64, window: String? = "w1", channel: String? = "c") -> Message {
            var m = Message(id: id, content: id, authorName: "Ada", characterName: nil, kind: "roll", seq: seq)
            m.chatWindowId = window; m.channelId = channel
            return m
        }
        let chat = [line("a", 1), line("card", 2), line("c", 5)]
        let merged = H.mergeLines(chat, [line("roll", 4), line("c", 5), line("other", 6, window: "w2"), line("away", 7, channel: "c2"), line("roll", 4)], channel: "c", window: "w1")
        XCTAssertEqual(merged.map(\.id), ["a", "card", "roll", "c"])
        XCTAssertEqual(H.mergeLines(chat, [], channel: "c", window: "w1"), chat)
        var pushed = line("c", 5); pushed.recalledAt = "2026-11-14T00:00:00Z"
        XCTAssertTrue(H.mergeLines([pushed], [line("c", 5)], channel: "c", window: "w1")[0].recalled, "a line already here is kept as it is")
        XCTAssertEqual(H.mergeLines(chat, [line("n", 9, window: nil, channel: nil)], channel: "c", window: "w1").last?.id, "n")
    }

    func testTheEngineHostsRules() throws {
        let rules = try JSONDecoder().decode(JSONValue.self, from: Data(H.EngineHost.contentRules.utf8)).array
        XCTAssertEqual(rules.count, 3)
        XCTAssertEqual(rules[0], j(#"{"trigger":{"url-filter":".*"},"action":{"type":"block"}}"#), "everything is blocked first")
        XCTAssertEqual(rules.dropFirst().map { $0["trigger"]["url-filter"].text }, ["^file:", "^blob:"])
        XCTAssertTrue(rules.dropFirst().allSatisfy { $0["action"]["type"] == .string("ignore-previous-rules") && $0["trigger"].object.count == 1 })
        // The host's backstops come after the bundle's own marks.
        XCTAssertGreaterThan(H.EngineHost.runTimeout(warm: true), H.engineTimeout)
        XCTAssertGreaterThan(H.EngineHost.runTimeout(warm: false), H.engineColdTimeout)
        XCTAssertGreaterThan(H.EngineHost.loadTimeout, H.engineColdTimeout)
        XCTAssertEqual(H.EngineHost.idle, 120)
        // The bundle starts a new worker after it ended one or one stopped: the next run gets the cold backstop.
        XCTAssertTrue(H.EngineHost.restartsWorker(H.failureText(.timeout, "the script did not finish in time")))
        XCTAssertTrue(H.EngineHost.restartsWorker(#"{"ok":false,"error":{"code":"engine","message":"the engine stopped"}}"#))
        XCTAssertFalse(H.EngineHost.restartsWorker(H.failureText(.budget, "x")))
        XCTAssertFalse(H.EngineHost.restartsWorker(H.failureText(.scriptError, "x")))
        XCTAssertFalse(H.EngineHost.restartsWorker(#"{"ok":true,"state":{}}"#))
        XCTAssertFalse(H.EngineHost.restartsWorker(#"{"ok":true,"error":{"code":"engine"}}"#))
        XCTAssertFalse(H.EngineHost.restartsWorker("not json"))
        // The scripts give a string on every path and read the request from their argument.
        XCTAssertTrue(H.EngineHost.runScript.contains("MobileHypertext.run(\(H.EngineHost.runArgument))"))
        XCTAssertTrue(H.EngineHost.readyScript.hasSuffix("return '';"))
        XCTAssertFalse(H.EngineHost.readyScript.contains("return null"))
    }
}
