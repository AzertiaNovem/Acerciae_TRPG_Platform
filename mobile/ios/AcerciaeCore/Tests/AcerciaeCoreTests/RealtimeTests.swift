import XCTest
@testable import AcerciaeCore

final class RealtimeTests: XCTestCase {
    /// The chat-stream frames of contracts/fixtures/realtime-events.json, each as the text the socket receives.
    private func frames() throws -> [String] {
        var directory = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { directory.deleteLastPathComponent() }
        let data = try Data(contentsOf: directory.appendingPathComponent("contracts/fixtures/realtime-events.json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try XCTUnwrap(root["events"] as? [Any])
        return try events.map { String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self) }
    }

    func testDecodesTheServersFramesIncludingARecallTombstone() throws {
        let events = try frames().map { try XCTUnwrap(RealtimeEvent.parse($0)) }
        XCTAssertEqual(events.map(\.type), ["hello", "subscribed", "message.posted", "message.recalled", "window.changed"])
        let posted = try XCTUnwrap(events[2].message), tombstone = try XCTUnwrap(events[3].message)
        XCTAssertEqual(posted.displayText, "I look at teh brass lantern.")
        XCTAssertEqual(posted.recallSecondsLeft, 120); XCTAssertFalse(posted.recalled)
        XCTAssertEqual(posted.id, tombstone.id); XCTAssertEqual(posted.seq, tombstone.seq)
        XCTAssertTrue(tombstone.recalled); XCTAssertEqual(tombstone.displayText, ""); XCTAssertNil(tombstone.recallSecondsLeft)
        XCTAssertEqual(events[2].channelId, events[4].channelId); XCTAssertNil(events[4].message)
        XCTAssertNil(RealtimeEvent.parse("not json")); XCTAssertNil(RealtimeEvent.parse(#"{"no":"type"}"#))
    }

    func testPausesGrowToFifteenSeconds() {
        XCTAssertEqual((0...5).map(reconnectPause), [1, 2, 4, 8, 15, 15])
    }

    private func line(_ id: String, left: Int? = 120, recalled: String? = nil) -> Message {
        var m = Message(id: id, content: recalled == nil ? "line \(id)" : "", authorName: "Ann", characterName: nil, kind: "ic", seq: 1)
        m.authorId = "u"; m.recalledAt = recalled; m.recallSecondsLeft = left
        return m
    }

    func testDeadlinesComeFromTheFirstCopyAndNeverGrow() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        var deadlines = RecallDeadlines()
        deadlines.note(line("a", left: 100), now: start)
        XCTAssertTrue(deadlines.open(line("a"), now: start))
        deadlines.note(line("a", left: 110), now: start)   // a later copy saying more time: ignored
        XCTAssertFalse(deadlines.open(line("a"), now: start.addingTimeInterval(105)))
        XCTAssertTrue(deadlines.expired(line("a"), now: start.addingTimeInterval(105)))
        XCTAssertFalse(deadlines.open(line("b"), now: start), "never seen: not offered")
        deadlines.note(line("c", left: nil), now: start); XCTAssertFalse(deadlines.open(line("c"), now: start))
        deadlines.note(line("d", left: 30), now: start); XCTAssertTrue(deadlines.open(line("d"), now: start))
        XCTAssertFalse(deadlines.open(line("d", recalled: "2026-11-07T00:00:00Z"), now: start), "a tombstone cannot be recalled")
    }

    func testATombstoneTakesItsLinesPlace() {
        let lines = [line("a"), line("b")]
        XCTAssertEqual(lines.withRecall(line("a", left: nil, recalled: "2026-11-07T00:00:00Z")).map(\.content), ["", "line b"])
        XCTAssertEqual(lines.withRecall(line("z", left: nil, recalled: "2026-11-07T00:00:00Z")).map(\.content), ["line a", "line b"])
    }
}
