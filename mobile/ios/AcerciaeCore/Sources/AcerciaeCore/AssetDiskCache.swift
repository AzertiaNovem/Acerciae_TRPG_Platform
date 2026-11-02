import CryptoKit
import Foundation

/// Bounded account-local storage. Call read/write from background work; clear invalidates in-flight writes.
/// The app places this in Application Support, outside the OS-purgeable caches directory.
public final class AssetDiskCache: @unchecked Sendable {
    private let directory: URL
    private let capBytes: Int
    private let legacyDirectory: URL?
    private let lock = NSLock()
    private let files = FileManager.default
    private let memory = NSCache<NSString, NSData>()
    private var revision = 0
    private var sequence = 0
    private var latest: [String:Int] = [:]
    public func reserve(_ key: String) -> Int { lock.lock(); defer { lock.unlock() }; sequence += 1; latest[key] = sequence; return sequence }
    private var enabled = true
    public var generation: Int { lock.lock(); defer { lock.unlock() }; return revision }

    public init(directory: URL, capBytes: Int = 512 * 1024 * 1024, legacyDirectory: URL? = nil) {
        self.directory = directory; self.capBytes = capBytes; self.legacyDirectory = legacyDirectory; memory.totalCostLimit = 24 * 1024 * 1024
    }

    public func get(_ key: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard enabled else { return nil }
        migrate()
        let name = Self.hex(key) as NSString
        if let data = memory.object(forKey: name) { try? files.setAttributes([.modificationDate: Date()], ofItemAtPath: file(key).path); return data as Data }
        let url = file(key)
        guard let data = try? Data(contentsOf: url) else { return nil }
        try? files.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        memory.setObject(data as NSData, forKey: name, cost: data.count)
        return data
    }

    public func put(_ key: String, _ data: Data, generation: Int? = nil, ticket: Int? = nil) {
        guard data.count <= capBytes else { return }
        lock.lock(); defer { lock.unlock() }
        guard enabled, generation == nil || generation == revision, ticket == nil || latest[key] == ticket else { return }
        migrate()
        let name = Self.hex(key) as NSString
        if let old = memory.object(forKey: name), old as Data == data { try? files.setAttributes([.modificationDate: Date()], ofItemAtPath: file(key).path); return }
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
    private func trim() {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let urls = try? files.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
        let entries = urls.compactMap { url -> (URL, Date, Int)? in
            guard let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, v.contentModificationDate ?? .distantPast, v.fileSize ?? 0)
        }.sorted { $0.1 < $1.1 }
        var total = entries.reduce(0) { $0 + $1.2 }
        for (url, _, size) in entries where total > capBytes { try? files.removeItem(at: url); memory.removeObject(forKey: url.lastPathComponent as NSString); total -= size }
    }

    private func file(_ key: String) -> URL { directory.appendingPathComponent(Self.hex(key)) }

    public static func keepable(_ cacheControl: String?) -> Bool {
        let directives = (cacheControl ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        return directives.contains("immutable") && !directives.contains("no-store")
    }
    public static func hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
