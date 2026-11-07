import Foundation

public enum ReadCachePolicy {
    public static func keep(_ path: [String]) -> Bool {
        guard let first = path.first else { return false }
        if first == "servers" { return path.count == 1 || (path.count == 3 && ["channels", "settings"].contains(path[2])) }
        if ["coc7", "dnd"].contains(first) { return path.last == "rules" }
        guard first == "channels", path.count >= 2 else { return false }
        if path.count == 2 { return true }
        return ["windows", "characters", "scenes", "documents", "highlights", "reminders", "atmosphere", "world", "pbta"].contains(path[2])
            && !path.contains("assets")
    }
}

actor AssetTransfers {
    private var pending: [String: Task<Data, Error>] = [:]
    func load(key: String, cache: AssetDiskCache?, fetch: @escaping @Sendable () async throws -> (Data, Bool)) async throws -> Data {
        if let task = pending[key] { let data = try await task.value; try Task.checkCancellation(); return data }
        let generation = cache?.generation ?? 0
        let task = Task<Data, Error> {
            if let data = await cache?.read(key) { return data }
            let (data, keep) = try await fetch()
            if keep, let cache { await cache.write(key, data, generation: generation) }
            return data
        }
        pending[key] = task
        defer { pending[key] = nil }
        let data = try await task.value
        try Task.checkCancellation()
        return data
    }
}
