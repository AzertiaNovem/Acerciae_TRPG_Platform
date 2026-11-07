import Foundation

/// When each of the user's own lines stops being recallable: `recall_seconds_left` of the first copy that arrived,
/// on this device's clock (a later copy can shorten it, never extend it). The server decides in the end.
public struct RecallDeadlines: Sendable {
    private var until: [String: Date] = [:]
    public init() {}
    public mutating func note(_ messages: [Message], now: Date = Date()) { for m in messages { note(m, now: now) } }
    public mutating func note(_ m: Message, now: Date = Date()) {
        guard let left = m.recallSecondsLeft, !m.recalled else { return }
        let at = now.addingTimeInterval(Double(left))
        if until[m.id].map({ $0 > at }) ?? true { until[m.id] = at }
        if until.count > 200 { until = until.filter { $0.value > now } }
    }
    public func open(_ m: Message, now: Date = Date()) -> Bool { !m.recalled && (until[m.id].map { $0 > now } ?? false) }
    public func expired(_ m: Message, now: Date = Date()) -> Bool { until[m.id].map { $0 <= now } ?? true }
    public mutating func clear() { until = [:] }
}

public extension Array where Element == Message {
    /// The lines with `tombstone` in its line's place (unchanged when the line is not there).
    func withRecall(_ tombstone: Message) -> [Message] { map { $0.id == tombstone.id ? tombstone : $0 } }
}
