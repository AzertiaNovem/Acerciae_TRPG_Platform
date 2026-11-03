import Foundation

public enum LocalStudioError: LocalizedError {
    case invalidFile
    public var errorDescription: String? { "Invalid local project file or size limit exceeded" }
}

/// User-created works, independent of account sessions and evictable caches.
public actor LocalStudioStore {
    private let root: URL
    public init(root: URL) { self.root = root }
    private func folder(_ id: String) throws -> URL {
        guard UUID(uuidString:id) != nil else { throw LocalStudioError.invalidFile }
        return root.appendingPathComponent(id, isDirectory:true)
    }
    public func list() throws -> [JSONValue] {
        guard FileManager.default.fileExists(atPath:root.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at:root, includingPropertiesForKeys:nil).compactMap { url in
            guard UUID(uuidString:url.lastPathComponent) != nil, let data = try? Data(contentsOf:url.appendingPathComponent("meta.json")) else { return nil }
            return try? JSONDecoder().decode(JSONValue.self,from:data)
        }.sorted { $0["updated_at"].text > $1["updated_at"].text }
    }
    public func load(_ id: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:folder(id).appendingPathComponent("project.json")))
    }
    public func save(_ project: JSONValue) throws {
        try Task.checkCancellation()
        let dir = try folder(project["id"].text)
        let data = try JSONEncoder().encode(project)
        guard data.count <= 16 * 1024 * 1024 else { throw LocalStudioError.invalidFile }
        try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
        try write(data,to:dir.appendingPathComponent("project.json"))
        let meta: JSONValue = .object(["id":project["id"],"title":project["title"],"events":.number(Double(project["events"].array.count)),"characters":.number(Double(project["characters"].array.count)),"updated_at":.string(ISO8601DateFormatter().string(from:Date()))])
        try write(JSONEncoder().encode(meta),to:dir.appendingPathComponent("meta.json"))
    }
    private func write(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to:url,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to:url,options:.atomic)
        #endif
    }
    public func delete(_ id: String) throws { try FileManager.default.removeItem(at:folder(id)) }
    private func assetFile(_ id: String, _ path: String) throws -> URL {
        guard path.range(of:"^assets/[A-Za-z0-9-]+\\.(png|jpg|jpeg|webp)$",options:.regularExpression) != nil else { throw LocalStudioError.invalidFile }
        return try folder(id).appendingPathComponent(path)
    }
    public func assets(_ id: String) throws -> JSONValue {
        let dir = try folder(id).appendingPathComponent("assets")
        guard FileManager.default.fileExists(atPath:dir.path) else { return .object([:]) }
        var values: [String:JSONValue] = [:]; var total = 0
        for url in try FileManager.default.contentsOfDirectory(at:dir,includingPropertiesForKeys:nil) {
            let path = "assets/" + url.lastPathComponent; _ = try assetFile(id,path)
            let data = try Data(contentsOf:url); total += data.count
            guard total <= 20 * 1024 * 1024 else { throw LocalStudioError.invalidFile }
            let mime = url.pathExtension == "png" ? "png" : url.pathExtension == "webp" ? "webp" : "jpeg"
            values[path] = .string("data:image/\(mime);base64," + data.base64EncodedString())
        }
        return .object(values)
    }
    public func readAsset(_ id: String, _ path: String) throws -> Data { try Data(contentsOf:assetFile(id,path)) }
    public func addAssets(_ id: String, _ values: JSONValue) throws {
        guard !values.object.isEmpty else { return }
        let existing = try assets(id).object
        var combined = existing; values.object.forEach { combined[$0.key] = $0.value }
        guard combined.values.reduce(0, { $0 + $1.text.utf8.count }) <= 28 * 1024 * 1024 else { throw LocalStudioError.invalidFile }
        let decoded = try combined.map { (path,value) -> (String,Data) in
            _ = try assetFile(id,path)
            guard value.text.range(of:"^data:image/(png|jpeg|webp);base64,",options:.regularExpression) != nil,
                  let data = Data(base64Encoded:String(value.text.split(separator:",",maxSplits:1).last ?? "")), data.count <= 10 * 1024 * 1024 else { throw LocalStudioError.invalidFile }
            return (path,data)
        }
        guard decoded.reduce(0, { $0 + $1.1.count }) <= 20 * 1024 * 1024 else { throw LocalStudioError.invalidFile }
        for (path,data) in decoded where values.object[path] != nil {
            let file = try assetFile(id,path)
            try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
            try write(data,to:file)
        }
    }
    public func removeUnusedAsset(_ id: String, _ path: String, project: JSONValue) throws {
        guard path.hasPrefix("assets/") else { return }
        func references(_ value: JSONValue) -> Bool {
            switch value { case .string(let text): return text == path; case .array(let rows): return rows.contains(where:references); case .object(let fields): return fields.values.contains(where:references); default: return false }
        }
        guard !references(project) else { return }
        let file = try assetFile(id,path)
        if FileManager.default.fileExists(atPath:file.path) { try FileManager.default.removeItem(at:file) }
    }
}
