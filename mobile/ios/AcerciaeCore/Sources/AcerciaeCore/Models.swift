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
    public let avatarData: String?
    public let avatarVersion: Int?
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
public struct Message: Codable, Identifiable, Sendable {
    public let id: String
    public let content: String
    public let authorName: String
    public let characterName: String?
    public let kind: String
    public let seq: Int64
    public var authorId: String? = nil
    public var characterId: String? = nil
    public var characterAvatarAssetId: String? = nil
    public var characterAvatarVersion: Int? = nil
    public var authorAvatarVersion: Int? = nil
    public var dice: JSONValue? = nil
    public var visibility: String? = nil
    public var displayText: String { dice?["text"].string ?? (diceTone == .notice ? "" : content) }
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
    public static func decode(_ data: Data) throws -> DemoCampaign { try APIJSON.decoder().decode(Self.self, from: data) }
}
public enum APIJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase; return decoder
    }
}

/// Lossless extensible payloads for dice and Log Studio. Dictionary keys retain server spelling.
public enum JSONValue: Codable, Sendable, Equatable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
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
