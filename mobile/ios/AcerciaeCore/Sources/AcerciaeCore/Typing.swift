import Foundation

/// A character being written as in a window of a channel: what a typing flag is raised for (docs/API.md).
public struct TypingTarget: Equatable, Sendable {
    public let channelId: String
    public let windowId: String
    public let characterId: String
    /// Nil unless all three are known: the flag is the character's, so writing as oneself raises none.
    public init?(channelId: String, windowId: String, characterId: String) {
        guard !channelId.isEmpty, !windowId.isEmpty, !characterId.isEmpty else { return nil }
        self.channelId = channelId; self.windowId = windowId; self.characterId = characterId
    }
    public func pack(active: Bool) -> JSONValue {
        .object(["type": .string("typing"), "channel_id": .string(channelId), "chat_window_id": .string(windowId),
                 "character_id": .string(characterId), "active": .bool(active)])
    }
}

/// The composer's side of a typing flag. The first edit raises it with a `typing` pack; `tick` (about once a second)
/// yields another every `heartbeat` seconds, since the server lets a flag fall 10 s after the last pack, so a lost
/// connection never leaves a character typing; it is lowered as soon as the line is sent or the text cleared, when the
/// writer pauses for `idle` seconds, or when the window or character changes. Each call returns the packs to send, in
/// order; a pack dropped while the stream is down does no harm, the next heartbeat raises the flag again.
public struct TypingSignal: Sendable {
    public static let heartbeat: TimeInterval = 4
    public static let idle: TimeInterval = 8
    private var target: TypingTarget?
    private var lastEdit = Date.distantPast
    private var lastPack = Date.distantPast
    public init() {}
    /// The character the flag is up for, if any.
    public var raisedFor: String? { target?.characterId }

    /// The writer changed the text to `text`, writing as `to` (nil: as nobody a flag can be raised for).
    public mutating func edited(_ to: TypingTarget?, text: String, now: Date = Date()) -> [JSONValue] {
        guard let to, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return lower() }
        var packs: [JSONValue] = []
        if let current = target, current != to { packs = lower() }
        lastEdit = now
        if target == nil { target = to; lastPack = now; packs.append(to.pack(active: true)) }
        return packs
    }
    public mutating func tick(now: Date = Date()) -> [JSONValue] {
        guard let current = target else { return [] }
        if now.timeIntervalSince(lastEdit) > Self.idle { return lower() }
        if now.timeIntervalSince(lastPack) >= Self.heartbeat { lastPack = now; return [current.pack(active: true)] }
        return []
    }
    public mutating func lower() -> [JSONValue] {
        guard let current = target else { return [] }
        target = nil
        return [current.pack(active: false)]
    }
    /// The stream was closed: the server dropped the flag with the socket, so there is nothing to send.
    public mutating func forget() { target = nil }
}

/// Who is being written as right now: character id to the window it is typed in (the flag is the character's, not the
/// user's), fed by the chat stream's `typing.changed` and `typing.snapshot`. The server announces each flag once when
/// it goes up and once when it falls (heartbeats are not relayed) and sends the whole list after every subscription,
/// so `stale` is only a last resort for a fall that never arrived.
public struct TypingFlags: Sendable {
    public static let stale: TimeInterval = 10 * 60
    private struct Flag: Sendable { let windowId: String; let until: Date }
    private var flags: [String: Flag] = [:]
    public init() {}
    public var byCharacter: [String: String] { flags.mapValues { $0.windowId } }

    /// Applies a chat-stream event; true when it was a typing event (changed or not), false for anything else.
    public mutating func apply(_ event: RealtimeEvent, now: Date = Date()) -> Bool {
        switch event.type {
        case "typing.changed":
            let character = event.payload["character_id"].text
            if character.isEmpty { return true }
            if event.payload["active"].bool {
                flags[character] = Flag(windowId: event.payload["chat_window_id"].text, until: now.addingTimeInterval(Self.stale))
            } else { flags[character] = nil }
            return true
        case "typing.snapshot":
            flags = [:]
            for row in event.payload["typing"].array {
                let character = row["character_id"].text
                if !character.isEmpty { flags[character] = Flag(windowId: row["chat_window_id"].text, until: now.addingTimeInterval(Self.stale)) }
            }
            return true
        default: return false
        }
    }
    /// Drops flags past `stale`; true when one fell.
    public mutating func prune(now: Date = Date()) -> Bool {
        let before = flags.count
        flags = flags.filter { $0.value.until > now }
        return flags.count != before
    }
    public mutating func clear() { flags = [:] }
}
