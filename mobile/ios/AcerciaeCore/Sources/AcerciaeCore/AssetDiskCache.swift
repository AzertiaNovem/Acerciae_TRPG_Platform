import CryptoKit
import Foundation

/// Bounded account-local storage. Call read/write from background work; clear invalidates in-flight writes.
/// The app places this in Application Support, outside the OS-purgeable caches directory.
///
/// An entry is keyed by the picture's content hash when the server named one (`key(hash:url:)`), else by its URL. Each
/// use renews its lifespan (the file's modification date): an entry not used for `maxAge` is dropped, and beyond
/// `capBytes` the least recently used go first. A picture whose hash did not change is never downloaded again while it lives.
public final class AssetDiskCache: @unchecked Sendable {
    public static let defaultMaxAge: TimeInterval = 30 * 24 * 60 * 60
    private let directory: URL
    private let capBytes: Int
    private let legacyDirectory: URL?
    private let maxAge: TimeInterval
    private let now: () -> Date
    private let lock = NSLock()
    private let files = FileManager.default
    private let memory = NSCache<NSString, NSData>()
    private var revision = 0
    private var sequence = 0
    private var latest: [String:Int] = [:]
    public func reserve(_ key: String) -> Int { lock.lock(); defer { lock.unlock() }; sequence += 1; latest[key] = sequence; return sequence }
    private var enabled = true
    public var generation: Int { lock.lock(); defer { lock.unlock() }; return revision }

    public init(directory: URL, capBytes: Int = 512 * 1024 * 1024, legacyDirectory: URL? = nil, maxAge: TimeInterval = AssetDiskCache.defaultMaxAge, now: @escaping () -> Date = { Date() }) {
        self.directory = directory; self.capBytes = capBytes; self.legacyDirectory = legacyDirectory; self.maxAge = maxAge; self.now = now; memory.totalCostLimit = 24 * 1024 * 1024
    }
    /// The cache key for a picture: its content hash when the server named one, else the URL it is fetched from.
    public static func key(hash: String?, url: String) -> String { if let hash, !hash.isEmpty { return "sha:" + hash }; return url }
    private func expired(_ url: URL) -> Bool {
        guard let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate else { return false }
        return now().timeIntervalSince(modified) > maxAge
    }

    private var swept = false
    public func get(_ key: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard enabled else { return nil }
        migrate()
        if !swept { swept = true; trim() }   // once per process: what expired goes before anything is read
        let name = Self.hex(key) as NSString
        let url = file(key)
        if files.fileExists(atPath: url.path), expired(url) {   // not used for maxAge: downloaded again
            memory.removeObject(forKey: name); try? files.removeItem(at: url); return nil
        }
        if let data = memory.object(forKey: name) { try? files.setAttributes([.modificationDate: now()], ofItemAtPath: url.path); return data as Data }
        guard let data = try? Data(contentsOf: url) else { return nil }
        try? files.setAttributes([.modificationDate: now()], ofItemAtPath: url.path)   // used: the lifespan starts over
        memory.setObject(data as NSData, forKey: name, cost: data.count)
        return data
    }

    public func put(_ key: String, _ data: Data, generation: Int? = nil, ticket: Int? = nil) {
        guard data.count <= capBytes else { return }
        lock.lock(); defer { lock.unlock() }
        guard enabled, generation == nil || generation == revision, ticket == nil || latest[key] == ticket else { return }
        migrate()
        let name = Self.hex(key) as NSString
        if let old = memory.object(forKey: name), old as Data == data { try? files.setAttributes([.modificationDate: now()], ofItemAtPath: file(key).path); return }
        do {
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
            var protectedDirectory = directory
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try? protectedDirectory.setResourceValues(values)
            #if os(iOS)
            try data.write(to: file(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: file(key), options: .atomic)
            #endif
            memory.setObject(data as NSData, forKey: name, cost: data.count)
            trim()
        } catch { /* a full disk just means no caching */ }
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        revision += 1; latest.removeAll(); memory.removeAllObjects()
        try? files.removeItem(at: directory)
        if let legacyDirectory { try? files.removeItem(at: legacyDirectory) }
    }
    public func invalidate() {
        lock.lock(); enabled = false; lock.unlock(); clear()
    }
    public func read(_ key: String) async -> Data? {
        await Task.detached(priority: .userInitiated) { self.get(key) }.value
    }
    public func write(_ key: String, _ data: Data, generation: Int, ticket: Int? = nil) async {
        await Task.detached(priority: .utility) { self.put(key, data, generation: generation, ticket: ticket) }.value
    }

    private func migrate() {
        guard let legacyDirectory, !files.fileExists(atPath: directory.path), files.fileExists(atPath: legacyDirectory.path) else { return }
        try? files.createDirectory(at: directory.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? files.moveItem(at: legacyDirectory, to: directory)
        var target = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
        #if os(iOS)
        for url in (try? files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            try? files.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        }
        #endif
    }
    public func remove(_ key: String) {
        lock.lock(); defer { lock.unlock() }
        revision += 1; memory.removeObject(forKey: Self.hex(key) as NSString); try? files.removeItem(at: file(key))
    }
    /// Drops what expired, then the least recently used beyond the cap. Also runs on `sweep()` at app start.
    private func trim() {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let urls = try? files.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
        let all = urls.compactMap { url -> (URL, Date, Int)? in
            guard let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, v.contentModificationDate ?? .distantPast, v.fileSize ?? 0)
        }.sorted { $0.1 < $1.1 }
        let cutoff = now().addingTimeInterval(-maxAge)
        var entries: [(URL, Date, Int)] = []
        for e in all { if e.1 < cutoff { try? files.removeItem(at: e.0); memory.removeObject(forKey: e.0.lastPathComponent as NSString) } else { entries.append(e) } }
        var total = entries.reduce(0) { $0 + $1.2 }
        for (url, _, size) in entries where total > capBytes { try? files.removeItem(at: url); memory.removeObject(forKey: url.lastPathComponent as NSString); total -= size }
    }
    public func sweep() { lock.lock(); defer { lock.unlock() }; if enabled { trim() } }

    private func file(_ key: String) -> URL { directory.appendingPathComponent(Self.hex(key)) }

    public static func keepable(_ cacheControl: String?) -> Bool {
        let directives = (cacheControl ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        return directives.contains("immutable") && !directives.contains("no-store")
    }
    public static func hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
