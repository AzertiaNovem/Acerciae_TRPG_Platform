import Foundation

public struct CharacterArtwork: Equatable, Sendable {
    public let id: String
    public let version: Int
    public let hash: String
    public var query: [String: String] { version > 0 ? ["v": String(version)] : [:] }

    public static func avatar(character: Resource?, message: Message? = nil) -> Self? {
        if let character {
            let id = character["avatar_asset_id"].text
            guard !id.isEmpty else { return nil }
            // Never combine a current asset with an older message's version or hash.
            return Self(id: id, version: character["avatar_asset_version"].int, hash: character["avatar_asset_hash"].text)
        }
        guard let message, let id = message.characterAvatarAssetId, !id.isEmpty else { return nil }
        return Self(id: id, version: message.characterAvatarVersion ?? 0, hash: message.characterAvatarHash ?? "")
    }

    public static func inSpace(_ space: JSONValue) -> [Self] {
        ([space["avatar"], space["portrait"]] + space["subtitles"].array).compactMap {
            guard !$0["id"].text.isEmpty else { return nil }
            return Self(id: $0["id"].text, version: $0["version"].int, hash: $0["hash"].string ?? $0["content_hash"].text)
        }
    }
}

/// One background transfer at a time. The caller owns cancellation and creates a new
/// worker when account/channel/permissions change. No decoded images or UI state live here.
public actor CharacterArtworkPrefetcher {
    private var spaces: [String: (revision: String, date: Date, value: JSONValue)] = [:]
    private var attempts: [String: Date] = [:]
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date = { Date() }) { self.now = now }

    public func warm(channel: String, characters: [Resource], client: BackendClient, token: String) async {
        guard let cache = client.assets else { return }
        let generation = cache.generation
        func active() -> Bool { !Task.isCancelled && cache.generation == generation }
        // All avatars go first, including those in a collapsed sidebar.
        for character in characters {
            guard active() else { return }
            if let avatar = CharacterArtwork.avatar(character: character) {
                await warm(avatar, channel: channel, client: client, token: token)
            }
        }
        for character in characters {
            guard active() else { return }
            let revision = character.value.pretty
            let space: JSONValue
            if let kept = spaces[character.id], kept.revision == revision, now().timeIntervalSince(kept.date) < 60 {
                space = kept.value
            } else {
                let attempt = "space:" + character.id + ":" + revision
                if let until = attempts[attempt], now() < until { continue }
                attempts[attempt] = now().addingTimeInterval(60)
                do {
                    space = try await client.resource(["channels", channel, "characters", character.id, "space"], token: token)
                    guard active() else { return }
                    spaces[character.id] = (revision, now(), space)
                } catch { continue } // Optional artwork must never become a chat/login error.
            }
            for asset in CharacterArtwork.inSpace(space) {
                guard active() else { return }
                await warm(asset, channel: channel, client: client, token: token)
            }
        }
        let ids = Set(characters.map(\.id))
        spaces = spaces.filter { ids.contains($0.key) }
        attempts = attempts.filter { $0.value > now() }
    }

    private func warm(_ asset: CharacterArtwork, channel: String, client: BackendClient, token: String) async {
        // Unversioned/GM-private responses must not be made persistent by prefetching.
        guard asset.version > 0, !Task.isCancelled else { return }
        let key = AssetDiskCache.key(hash: asset.hash, url: "\(channel)/\(asset.id)?v=\(asset.version)")
        if let until = attempts[key], now() < until { return }
        do {
            _ = try await client.bytes(["channels", channel, "media", asset.id], token: token, query: asset.query, hash: asset.hash)
            try Task.checkCancellation()
            // Avoid repeatedly downloading successful but non-persistable private images.
            attempts[key] = now().addingTimeInterval(300)
        } catch {
            if !Task.isCancelled { attempts[key] = now().addingTimeInterval(60) }
        }
    }
}
