import CryptoKit
import Foundation

/// Media the app has already downloaded (avatars, portraits, standees, backdrops, voice lines), kept in the app's
/// caches directory so each is fetched once. Only responses the server marks `immutable` are kept: a named version of
/// something a player may see. A stored object never changes, and the server never marks GM-private material, so it is
/// never written to disk. One directory per account and server; the least recently used files go first beyond
/// `capBytes`; signing out deletes them all.
public final class AssetDiskCache: @unchecked Sendable {
    private let directory: URL
    private let capBytes: Int
    private let lock = NSLock()
    private let files = FileManager.default

    public init(directory: URL, capBytes: Int = 200 * 1024 * 1024) {
        self.directory = directory; self.capBytes = capBytes
    }

    public func get(_ key: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        let url = file(key)
        guard let data = try? Data(contentsOf: url) else { return nil }
        try? files.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return data
    }

    public func put(_ key: String, _ data: Data) {
        guard data.count <= capBytes else { return }
        lock.lock(); defer { lock.unlock() }
        do {
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: file(key), options: .atomic)
            trim()
        } catch { /* a full disk just means no caching */ }
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        try? files.removeItem(at: directory)
    }

    private func trim() {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let urls = try? files.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
        let entries = urls.compactMap { url -> (URL, Date, Int)? in
            guard let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, v.contentModificationDate ?? .distantPast, v.fileSize ?? 0)
        }.sorted { $0.1 < $1.1 }
        var total = entries.reduce(0) { $0 + $1.2 }
        for (url, _, size) in entries where total > capBytes { try? files.removeItem(at: url); total -= size }
    }

    private func file(_ key: String) -> URL { directory.appendingPathComponent(Self.hex(key)) }

    public static func keepable(_ cacheControl: String?) -> Bool {
        (cacheControl ?? "").split(separator: ",").contains { $0.trimmingCharacters(in: .whitespaces).lowercased() == "immutable" }
    }
    public static func hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
