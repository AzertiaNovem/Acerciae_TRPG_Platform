import XCTest
@testable import AcerciaeCore

/// Typing flags, vitals, Inspiration options and pins, against contracts/fixtures/table-status.json (a live capture).
final class TableStatusTests: XCTestCase {
    private func loadFixture() throws -> JSONValue {
        var directory = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { directory.deleteLastPathComponent() }
        let data = try Data(contentsOf: directory.appendingPathComponent("contracts/fixtures/table-status.json"))
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
    private func event(_ json: String) throws -> RealtimeEvent { try XCTUnwrap(RealtimeEvent.parse(json)) }

    func testFlagsFollowTheStreamsSnapshotAndChanges() throws {
        let start = Date(timeIntervalSince1970: 1_000_000)
        var flags = TypingFlags()
        var frames: [RealtimeEvent] = []
        for frame in try loadFixture()["typing_frames"].array { frames.append(try event(frame.pretty)) }
        XCTAssertEqual(frames.map { $0.type }, ["typing.snapshot", "typing.changed", "typing.changed"])
        XCTAssertTrue(flags.apply(frames[0], now: start))
        XCTAssertEqual(flags.byCharacter, ["ada": "w1"])   // whoever was typing when we subscribed
        XCTAssertTrue(flags.apply(frames[1], now: start))
        XCTAssertTrue(flags.byCharacter.isEmpty)           // lowered
        XCTAssertTrue(flags.apply(frames[2], now: start))
        XCTAssertEqual(flags.byCharacter, ["ada": "w1"])   // raised again
        let other = try event(#"{"type":"message.posted","channel_id":"c1"}"#)
        XCTAssertFalse(flags.apply(other, now: start), "other events are not typing events")
        // The server relays no heartbeats: a flag stays up for as long as nothing lowers it, well past a long paragraph.
        XCTAssertFalse(flags.prune(now: start.addingTimeInterval(5 * 60)))
        XCTAssertEqual(Array(flags.byCharacter.keys), ["ada"])
        XCTAssertTrue(flags.prune(now: start.addingTimeInterval(5 * 60 + TypingFlags.stale)))
        XCTAssertTrue(flags.byCharacter.isEmpty)
        // A new snapshot replaces everything known before it.
        let snapshot = try event(#"{"type":"typing.snapshot","channel_id":"c1","typing":[{"character_id":"mo","chat_window_id":"w2"}]}"#)
        _ = flags.apply(frames[2], now: start)
        _ = flags.apply(snapshot, now: start)
        XCTAssertEqual(flags.byCharacter, ["mo": "w2"])
        flags.clear()
        XCTAssertTrue(flags.byCharacter.isEmpty)
    }

    func testTheComposerRaisesKeepsUpAndLowersItsFlag() throws {
        let start = Date(timeIntervalSince1970: 0)
        func at(_ seconds: TimeInterval) -> Date { start.addingTimeInterval(seconds) }
        func brief(_ packs: [JSONValue]) -> [String] {
            packs.map { $0["character_id"].text + "@" + $0["chat_window_id"].text + ($0["active"].bool ? "+" : "-") }
        }
        let nothing: [String] = []
        var signal = TypingSignal()
        let ada = try XCTUnwrap(TypingTarget(channelId: "c1", windowId: "w1", characterId: "ada"))
        XCTAssertNil(TypingTarget(channelId: "c1", windowId: "w1", characterId: ""), "as oneself there is no character to flag")
        let pack: JSONValue = .object(["type": .string("typing"), "channel_id": .string("c1"), "chat_window_id": .string("w1"), "character_id": .string("ada"), "active": .bool(true)])
        XCTAssertEqual(ada.pack(active: true), pack)

        // Blank text, or nobody to write as, raises nothing.
        XCTAssertEqual(brief(signal.edited(ada, text: "   ", now: at(0))), nothing)
        XCTAssertEqual(brief(signal.edited(nil, text: "I open the door", now: at(0))), nothing)
        XCTAssertEqual(brief(signal.tick(now: at(0))), nothing)
        XCTAssertEqual(brief(signal.edited(ada, text: "I", now: at(0))), ["ada@w1+"])
        XCTAssertEqual(signal.raisedFor, "ada")
        // One pack raises it; edits in between send nothing; a heartbeat every four seconds keeps it up.
        XCTAssertEqual(brief(signal.edited(ada, text: "I op", now: at(1))), nothing)
        XCTAssertEqual(brief(signal.tick(now: at(1))), nothing)
        XCTAssertEqual(brief(signal.tick(now: at(4))), ["ada@w1+"])
        XCTAssertEqual(brief(signal.tick(now: at(7.9))), nothing)
        XCTAssertEqual(brief(signal.tick(now: at(8))), ["ada@w1+"])
        // A pause of more than `idle` since the last edit (at 1 s) lowers it; later ticks send nothing.
        XCTAssertEqual(brief(signal.tick(now: at(9.001))), ["ada@w1-"])
        XCTAssertNil(signal.raisedFor)
        XCTAssertEqual(brief(signal.tick(now: at(20))), nothing)
        // Typing again raises it; sending the line (text cleared) lowers it at once.
        XCTAssertEqual(brief(signal.edited(ada, text: "I open the door", now: at(20))), ["ada@w1+"])
        XCTAssertEqual(brief(signal.edited(ada, text: "", now: at(21))), ["ada@w1-"])
        // Another window or character: the old flag falls before the new one goes up.
        XCTAssertEqual(brief(signal.edited(ada, text: "x", now: at(22))), ["ada@w1+"])
        let elsewhere = TypingTarget(channelId: "c1", windowId: "w2", characterId: "ada")
        XCTAssertEqual(brief(signal.edited(elsewhere, text: "xy", now: at(23))), ["ada@w1-", "ada@w2+"])
        XCTAssertEqual(brief(signal.lower()), ["ada@w2-"])
        XCTAssertEqual(brief(signal.lower()), nothing)
        // A closed stream took the flag with it: nothing to send, and the next edit raises it afresh.
        _ = signal.edited(ada, text: "again", now: at(30))
        signal.forget()
        XCTAssertEqual(brief(signal.tick(now: at(40))), nothing)
        XCTAssertEqual(brief(signal.edited(ada, text: "again!", now: at(41))), ["ada@w1+"])
    }

    func testVitalsReadAsTheSidebarShowsThem() throws {
        for item in try loadFixture()["vitals"].array {
            let parts = Vitals.parts(item["vitals"])
            let expected = item["parts"].array.map { VitalPart($0.array[0].text, $0.array[1].text, low: $0.array[2].bool) }
            XCTAssertEqual(parts, expected, item["name"].text)
            XCTAssertEqual(parts.map { $0.text }.joined(separator: " · "), item["line"].text, item["name"].text)
        }
        let bare: JSONValue = .object(["rule_system": .string("coc7e")])
        XCTAssertEqual(Vitals.parts(bare).map { $0.label }, ["HP", "SAN", "DEX"])
        XCTAssertTrue(Vitals.parts(.null).isEmpty)
    }

    func testInspirationOffersItsOptionsAndRemembersWhatWasShown() throws {
        let result = try loadFixture()["inspiration"]
        let options = Inspiration.options(result)
        XCTAssertEqual(options.count, 3)
        XCTAssertEqual(options.first?.text, result["draft"].text)
        XCTAssertEqual(options.map { $0.angle }, ["probing", "measured", "aside to the table"])
        XCTAssertEqual(options.map { $0.roll }, ["", ".ra Spot Hidden", ""])
        XCTAssertEqual(options.map { $0.kind }, ["ic", "ic", "ooc"])
        // A result with only a draft is one option; nothing at all is none.
        let draftOnly: JSONValue = .object(["draft": .string("I wait.")])
        XCTAssertEqual(Inspiration.options(draftOnly), [InspirationOption(text: "I wait.")])
        let blank: JSONValue = .object(["draft": .string(" ")])
        XCTAssertTrue(Inspiration.options(blank).isEmpty)
        let shown = Inspiration.shown([], result)
        XCTAssertEqual(shown, options.map { $0.text })
        XCTAssertEqual(Inspiration.shown(shown, result), shown, "shown twice is remembered once")
        let many = Inspiration.shown((1...20).map { "line \($0)" }, result)
        XCTAssertEqual(many.count, Inspiration.remembered)
        XCTAssertEqual(many.last, options.last?.text)
    }

    func testPinsAreFoundByTheirLineAndTakenDownByPinnerOrGm() throws {
        let data = try loadFixture()
        let reminders = try JSONDecoder().decode([Resource].self, from: JSONEncoder().encode(data["reminders"]))
        let me = data["viewer"]["id"].text, someoneElse = data["viewer"]["other"].text
        let pin = try XCTUnwrap(Pins.of(reminders, messageId: "m1"))
        XCTAssertEqual(pin.id, "r-pin")
        XCTAssertEqual(pin["pinned_by_name"].text, "Sam")
        XCTAssertNil(Pins.of(reminders, messageId: "m2"))
        XCTAssertNil(Pins.of(Array(reminders.dropFirst()), messageId: "m1"), "an AI reminder is no pin")
        XCTAssertTrue(Pins.canUnpin(pin, userId: me, gm: false))
        XCTAssertFalse(Pins.canUnpin(pin, userId: someoneElse, gm: false))
        XCTAssertFalse(Pins.canUnpin(pin, userId: nil, gm: false))
        XCTAssertTrue(Pins.canUnpin(pin, userId: someoneElse, gm: true), "the GM takes any pin down")
        XCTAssertFalse(Pins.canUnpin(reminders[1], userId: me, gm: true))
        func line(_ kind: String, recalled: String? = nil) -> Message {
            var message = Message(id: "m", content: "x", authorName: "Ann", characterName: nil, kind: kind, seq: 1)
            message.recalledAt = recalled
            return message
        }
        XCTAssertTrue(Pins.canPin(line("ic")))
        XCTAssertTrue(Pins.canPin(line("narration")))
        XCTAssertFalse(Pins.canPin(line("system")))
        XCTAssertFalse(Pins.canPin(line("ic", recalled: "2026-11-07T00:00:00Z")))
    }
}
