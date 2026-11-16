import Foundation

public struct Health: Decodable, Sendable {
    public let status: String
    public let llmMode: String
    public let db: String
    enum CodingKeys: String, CodingKey { case status, llmMode, db }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(String.self, forKey: .status)
        llmMode = try c.decodeIfPresent(String.self, forKey: .llmMode) ?? ""
        db = try c.decodeIfPresent(String.self, forKey: .db) ?? ""
    }
}
public struct User: Codable, Sendable {
    public let id: String
    public let username: String
    public let displayName: String
    public let uiLanguage: String?
    public let atmosphereEnabled: Bool?
    public let hasAvatar: Bool?
    public let avatarData: String?
    public let avatarVersion: Int?
    public var avatarHash: String? = nil
    /// "separate" (default) or "inline": how this account sees dice results.
    public var diceDisplay: String? = nil
}
public struct Session: Codable, Sendable, CustomStringConvertible {
    public let token: String
    public let user: User
    public init(token: String, user: User) { self.token = token; self.user = user }
    public var description: String { "Session(<redacted>)" }
}
public struct Server: Decodable, Identifiable, Sendable { public let id: String; public let name: String }
public struct Channel: Decodable, Identifiable, Sendable { public let id: String; public let name: String; public let myRole: String }
public struct ChatWindow: Decodable, Identifiable, Sendable { public let id: String; public let name: String; public let kind: String }
public struct Message: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let content: String
    public let authorName: String
    public let characterName: String?
    public let kind: String
    public let seq: Int64
    public var channelId: String? = nil
    public var mediaAssetId: String? = nil
    public var authorId: String? = nil
    public var characterId: String? = nil
    public var characterAvatarAssetId: String? = nil
    public var characterAvatarVersion: Int? = nil
    public var authorAvatarVersion: Int? = nil
    public var characterAvatarHash: String? = nil
    public var authorAvatarHash: String? = nil
    public var dice: JSONValue? = nil
    public var visibility: String? = nil
    public var referenceIds: [String]? = nil
    /// Recalled by its author: a tombstone (no text, dice or references) kept in the line's place.
    public var recalledAt: String? = nil
    /// Seconds left, when the message arrived, for its author to recall it; nil when it cannot be recalled.
    public var recallSecondsLeft: Int? = nil
    public var standIn: Bool? = nil
    /// The window the line belongs to: a line of an earlier window shows in a fork's history (its card stays locked).
    public var chatWindowId: String? = nil
    /// An interactive message's public card (kind `hypertext`) as stored; read it with `Hypertext.parseDoc`. Nil on
    /// every other kind and once the card is recalled. Older builds show and read aloud `content` instead.
    public var hypertext: JSONValue? = nil
    /// On a line an interactive message posted: the card, and who acted on it (on a reply the card's sender said,
    /// `viaUserId` is not the `authorId`).
    public var viaHypertextId: String? = nil
    public var viaUserId: String? = nil
    public var viaUserName: String? = nil
    public var recalled: Bool { recalledAt != nil }
    public var isHypertext: Bool { kind == "hypertext" }
    /// Who a card's reply answered ("answering {name}"): set only when someone other than the line's author acted.
    public var answering: String? {
        guard let via = viaUserId, !via.isEmpty, via != authorId, let name = viaUserName, !name.isEmpty else { return nil }
        return name
    }
    /// Whether read-aloud may speak the line: not a system line, not a card (its text is the plain fallback of labels
    /// and buttons, not something said at the table), not recalled.
    public var speakable: Bool { kind != "system" && kind != "hypertext" && !recalled }
    public var hasIllustration: Bool { !recalled && !(mediaAssetId ?? "").isEmpty }
    public var illustrationCaption: String { ChatIllustrations.caption(content) }
    public var displayText: String { recalled ? "" : dice?["text"].string ?? (diceTone == .notice ? "" : content) }
    public init(id: String, content: String, authorName: String, characterName: String?, kind: String, seq: Int64) {
        self.id = id; self.content = content; self.authorName = authorName
        self.characterName = characterName; self.kind = kind; self.seq = seq
    }
}
public struct DocumentSummary: Decodable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let docType: String
    public let version: Int
    public let gmOnly: Bool?
    public let preview: String?
}
public struct Highlight: Decodable, Identifiable, Sendable {
    public let id: String
    public let documentId: String
    public let targetEntryId: String?
    public let reason: String
    public let sourceEventIds: [String]
    public let expiresAt: String
}
public struct ReplayFrame: Decodable, Identifiable, Sendable {
    public let id: String
    public let speaker: String
    public let text: String
    public let atmosphere: String
}
// This is a bundled preview fixture, not a server or SeaLDice response format.
public struct DemoCampaign: Decodable, Sendable {
    public var title: String
    public var scene: String
    public var messages: [Message]
    public var documents: [DocumentSummary]
    public var highlights: [Highlight]
    public let replay: [ReplayFrame]
    public init(title: String, scene: String, messages: [Message], documents: [DocumentSummary] = [], highlights: [Highlight] = [], replay: [ReplayFrame] = []) {
        self.title = title; self.scene = scene; self.messages = messages; self.documents = documents; self.highlights = highlights; self.replay = replay
    }
    public static func decode(_ data: Data) throws -> DemoCampaign { try APIJSON.decoder().decode(Self.self, from: data) }
}
public struct ChatHistory: Codable, Sendable, Equatable {
    public var messages: [Message]
    public var hasOlder: Bool
    public init(messages: [Message], hasOlder: Bool) { self.messages = messages; self.hasOlder = hasOlder }
    public static func merge(_ existing: [Message], _ incoming: [Message], recalled: [String: Message]) -> [Message] {
        var byId: [String: Message] = [:]
        for message in existing { byId[message.id] = message }
        for message in incoming { byId[message.id] = message }
        return byId.values.map { recalled[$0.id] ?? $0 }.sorted { $0.seq < $1.seq }
    }
}
public enum APIJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase; return decoder
    }
}

/// Lossless extensible payloads for dice and Log Studio. Dictionary keys retain server spelling.
public enum JSONValue: Codable, Sendable, Equatable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public var id: String { self["id"].text }
    public var name: String { self["name"].string ?? self["title"].text }
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSONValue { if case .object(let v) = self { return v[key] ?? .null }; return .null }
    public var string: String? { if case .string(let v) = self { return v }; return nil }
    public var text: String { string ?? "" }
    public var bool: Bool { if case .bool(let v) = self { return v }; return false }
    public var int: Int { if case .number(let v) = self { return Int(v) }; return 0 }
    public var array: [JSONValue] { if case .array(let v) = self { return v }; return [] }
    public var object: [String: JSONValue] { if case .object(let v) = self { return v }; return [:] }
    public var pretty: String { let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]; return (try? String(data: e.encode(self), encoding: .utf8)) ?? "" }
}
public struct Resource: Decodable, Identifiable, Sendable {
    public let value: JSONValue
    public init(from decoder: Decoder) throws { value = try JSONValue(from: decoder) }
    public var id: String { value["id"].text }
    public var name: String { value["name"].string ?? value["title"].text }
    public subscript(_ key: String) -> JSONValue { value[key] }
}
