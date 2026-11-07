import Foundation

public enum ClientError: Error, LocalizedError {
    case invalidAddress, insecureAddress, http(Int), gateway(Int), invalidResponse, pointsRule(String)
    public var httpStatus: Int? { if case .http(let code) = self { return code }; return nil }
    public var errorDescription: String? {
        switch self {
        case .invalidAddress: "请输入服务根地址，不要包含账号、/api 或查询参数"
        case .insecureAddress: "远程服务需要 HTTPS；调试版仅允许本机 HTTP"
        case .http(401): "登录已过期，请重新登录"
        case .http(403): "当前账号没有权限，或管理员已关闭此功能"
        case .http(404): "内容不可用，或服务版本尚未提供此功能"
        case .http(429): "请求过多或已达到预算限制，请稍后重试"
        case .http(let status): "服务请求失败（HTTP \(status)）"
        case .gateway(let status): "服务入口暂时不可用（HTTP \(status)），请稍后重试"
        case .invalidResponse: "服务返回的数据格式不兼容，请更新客户端或联系管理员"
        case .pointsRule(let message): "购点校验未通过：" + message
        }
    }
}

public struct BackendAddress: Sendable {
    public let url: URL
    public init(_ value: String, allowLocalHTTP: Bool = false) throws {
        guard let c = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = c.host, !host.isEmpty, c.user == nil, c.password == nil,
              c.query == nil, c.fragment == nil, c.path.isEmpty || c.path == "/",
              let url = c.url else { throw ClientError.invalidAddress }
        let local = ["localhost", "127.0.0.1", "10.0.2.2"].contains(host.lowercased())
        guard c.scheme == "https" || (c.scheme == "http" && allowLocalHTTP && local) else { throw ClientError.insecureAddress }
        self.url = url
    }
    public func api(_ segments: [String]) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        components.percentEncodedPath = "/api/" + segments.map { $0.addingPercentEncoding(withAllowedCharacters: allowed)! }.joined(separator: "/")
        return components.url!
    }
    public func websocket(_ stream: RealtimeStream, token: String) -> URL {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.scheme = url.scheme == "https" ? "wss" : "ws"
        c.path = "/ws/\(stream.rawValue)"
        c.queryItems = [URLQueryItem(name: "token", value: token)]
        return c.url!
    }
}
public enum RealtimeStream: String, Sendable { case chat, context }

// The app owns secure session persistence. Never log authorization headers.
public struct BackendClient: Sendable {
    public let address: BackendAddress
    private let session: URLSession
    /// Downloaded media kept on disk for the signed-in account (see `AssetDiskCache`); nil keeps nothing.
    public let assets: AssetDiskCache?
    public let reads: AssetDiskCache?
    private let transfers = AssetTransfers()
    public init(address: BackendAddress, session: URLSession? = nil, assets: AssetDiskCache? = nil, reads: AssetDiskCache? = nil) {
        self.address = address; self.session = session ?? Self.makeSession(); self.assets = assets; self.reads = reads
    }
    /// The same client, keeping media in `assets` (once the account is known, after signing in).
    public func withAssets(_ assets: AssetDiskCache?, reads: AssetDiskCache? = nil) -> BackendClient { BackendClient(address: address, session: session, assets: assets, reads: reads) }
    private func cacheKey(_ path: [String], _ query: [String: String]) -> String {
        var c = URLComponents(url: address.api(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        return c.url!.absoluteString
    }
    public func cached<T: Decodable>(_ path: [String], query: [String: String] = [:]) async -> T? {
        guard let data = await reads?.read(cacheKey(path, query)) else { return nil }
        return try? APIJSON.decoder().decode(T.self, from: data)
    }
    public func request<T: Decodable>(_ path: [String], token: String? = nil, body: Data? = nil, method: String? = nil, query: [String: String] = [:]) async throws -> T {
        var components = URLComponents(url: address.api(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = body == nil ? 30 : 120
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpMethod = "POST"; request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let method { request.httpMethod = method }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let generation = reads?.generation ?? 0
        let ticket = (request.httpMethod ?? "GET") == "GET" && ReadCachePolicy.keep(path) ? reads?.reserve(cacheKey(path,query)) : nil
        let data: Data
        do { data = try await send(request) }
        catch {
            if let e = error as? ClientError, [401,403,404].contains(e.httpStatus ?? 0), let reads {
                let key = cacheKey(path, query)
                await Task.detached(priority: .utility) { reads.remove(key) }.value
            }
            throw error
        }
        let value = try decode(T.self, data: data)
        // Explicit stale-first reads only. Authorization and write preconditions always use the network.
        if (request.httpMethod ?? "GET") == "GET", ReadCachePolicy.keep(path), let reads {
            await reads.write(cacheKey(path, query), data, generation: generation, ticket: ticket)
        }
        return value
    }
    public func resource(_ path: [String], token: String, body: JSONValue? = nil, method: String? = nil, query: [String: String] = [:]) async throws -> JSONValue {
        try await request(path, token: token, body: try body.map { try JSONEncoder().encode($0) }, method: method, query: query)
    }
    /// Media bytes; with the picture's content `hash` the disk cache serves them by content (see `AssetDiskCache.key`).
    public func bytes(_ path: [String], token: String, query: [String: String] = [:], hash: String? = nil) async throws -> Data {
        var c = URLComponents(url: address.api(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        let url = c.url!; let key = AssetDiskCache.key(hash: hash, url: url.absoluteString)
        return try await transfers.load(key: key, cache: assets) {
            var r = URLRequest(url: url); r.timeoutInterval = 120
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await sendResponse(r)
            return (data, ChatIllustrations.keepable(response.value(forHTTPHeaderField: "Cache-Control"), path: path))
        }
    }
    public func forgetMessageImage(channel: String, message: String) async {
        let key = cacheKey(ChatIllustrations.path(channel: channel, message: message), [:])
        if let assets { await Task.detached(priority: .utility) { assets.remove(key) }.value }
    }

    public func uploadCharacterAsset(channel: String, character: String, slot: String, subtitle: String, data: Data, token: String) async throws -> JSONValue {
        guard data.count <= 10 * 1024 * 1024, ["avatar", "portrait", "subtitle"].contains(slot), !subtitle.contains("\r"), !subtitle.contains("\n") else { throw ClientError.invalidResponse }
        let boundary = "Mobile-" + UUID().uuidString
        var body = Data()
        for (name, value) in [("slot", slot), ("subtitle", subtitle)] {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"artwork.png\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8))
        body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = URLRequest(url: address.api(["channels", channel, "characters", character, "assets"]))
        request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 60
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        return try decode(JSONValue.self, data: await send(request))
    }
    public func uploadModule(channel: String, title: String, data: Data, token: String) async throws -> JSONValue {
        guard data.count <= 25 * 1024 * 1024 else { throw ClientError.invalidResponse }
        let boundary = "Mobile-" + UUID().uuidString
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\n\(title)\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"module.pdf\"\r\nContent-Type: application/pdf\r\n\r\n".utf8)
        body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = URLRequest(url: address.api(["channels", channel, "modules"]))
        request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 120
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        return try decode(JSONValue.self, data: await send(request))
    }
    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = true
        config.timeoutIntervalForResource = 180
        config.httpMaximumConnectionsPerHost = 4
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }
    private func decode<T: Decodable>(_ type: T.Type, data: Data) throws -> T {
        do { return try APIJSON.decoder().decode(type, from: data) }
        catch { throw ClientError.invalidResponse }
    }
    private func send(_ original: URLRequest) async throws -> Data { try await sendResponse(original).0 }
    /// The bytes and the response (the disk cache keeps only what its Cache-Control marks immutable).
    private func sendResponse(_ original: URLRequest) async throws -> (Data, HTTPURLResponse) {
        var request = original
        request.setValue("AcerciaeMobile/0.1 (iOS)", forHTTPHeaderField: "User-Agent")
        let readOnly = ["GET", "HEAD"].contains(request.httpMethod ?? "GET")
        for attempt in 0..<3 {
            try Task.checkCancellation()
            do {
                let (data, response) = try await session.data(for: request, delegate: NoRedirects())
                guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
                if readOnly && attempt < 2 && ConnectionPolicy.retryStatus(response.statusCode) {
                    try await Task.sleep(for: .milliseconds(400 * (1 << attempt))); continue
                }
                guard (200..<300).contains(response.statusCode) else {
                    // Edge/WAF HTML or text is not an application authorization decision.
                    let value = try? APIJSON.decoder().decode(JSONValue.self, from: data)
                    guard let error = value, !error["error"].text.isEmpty else { throw ClientError.gateway(response.statusCode) }
                    if response.statusCode == 400 && error["error"].text == "points_rule" { throw ClientError.pointsRule(String(error["message"].text.prefix(2000))) }
                    throw ClientError.http(response.statusCode)
                }
                return (data, response)
            } catch {
                if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
                guard readOnly && attempt < 2 && ConnectionPolicy.retryTransport(error) else { throw error }
                try await Task.sleep(for: .milliseconds(400 * (1 << attempt)))
            }
        }
        throw ClientError.invalidResponse
    }
    public func health() async throws -> Health { try await request(["health"]) }
    public func register(username: String, password: String, displayName: String) async throws -> Session {
        try await request(["auth", "register"], body: JSONEncoder().encode(["username": username, "password": password, "display_name": displayName]))
    }
    public func login(username: String, password: String) async throws -> Session {
        try await request(["auth", "login"], body: JSONEncoder().encode(["username": username, "password": password]))
    }
    public func servers(token: String) async throws -> [Server] { try await request(["servers"], token: token) }
    public func channels(token: String, server: String) async throws -> [Channel] { try await request(["servers", server, "channels"], token: token) }
    public func windows(token: String, channel: String) async throws -> [ChatWindow] { try await request(["channels", channel, "windows"], token: token) }
    public func messages(token: String, channel: String, window: String) async throws -> [Message] { try await request(["channels", channel, "windows", window, "messages"], token: token) }
    public func documents(token: String, channel: String) async throws -> [DocumentSummary] { try await request(["channels", channel, "documents"], token: token) }
    public func highlights(token: String, channel: String) async throws -> [Highlight] { try await request(["channels", channel, "highlights"], token: token) }
    /// A short-lived token for a URL that cannot carry headers (the WebSocket); the session token never goes into one.
    public func fileToken(token: String) async throws -> String { try await resource(["auth", "file-token"], token: token, body: .object([:]))["token"].text }
    /// Takes back one of the caller's own lines: its tombstone, and the text to edit and send again.
    public func recall(token: String, channel: String, message: String) async throws -> Recalled {
        try await request(["channels", channel, "messages", message, "recall"], token: token, body: Data("{}".utf8))
    }
}
public struct Recalled: Decodable, Sendable { public let message: Message; public let content: String }
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
