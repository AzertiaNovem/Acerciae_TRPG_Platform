import Foundation

public enum ClientError: Error, LocalizedError {
    case invalidAddress, insecureAddress, http(Int), invalidResponse, pointsRule(String)
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
        case .invalidResponse: "服务响应无效"
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
    private let address: BackendAddress
    private let session: URLSession
    public init(address: BackendAddress, session: URLSession = URLSession(configuration: .ephemeral)) {
        self.address = address; self.session = session
    }
    public func request<T: Decodable>(_ path: [String], token: String? = nil, body: Data? = nil, method: String? = nil, query: [String: String] = [:]) async throws -> T {
        var components = URLComponents(url: address.api(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 15
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpMethod = "POST"; request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let method { request.httpMethod = method }
        let (data, response) = try await session.data(for: request, delegate: NoRedirects())
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 400, let error = try? APIJSON.decoder().decode(JSONValue.self, from: data), error["error"].text == "points_rule" { throw ClientError.pointsRule(String(error["message"].text.prefix(2000))) }
            throw ClientError.http(response.statusCode)
        }
        return try APIJSON.decoder().decode(T.self, from: data)
    }
    public func resource(_ path: [String], token: String, body: JSONValue? = nil, method: String? = nil, query: [String: String] = [:]) async throws -> JSONValue {
        try await request(path, token: token, body: try body.map { try JSONEncoder().encode($0) }, method: method, query: query)
    }
    public func bytes(_ path: [String], token: String, query: [String: String] = [:]) async throws -> Data {
        var c = URLComponents(url: address.api(path), resolvingAgainstBaseURL: false)!
        c.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        var r = URLRequest(url: c.url!); r.timeoutInterval = 30
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: r, delegate: NoRedirects())
        guard let h = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(h.statusCode) else { throw ClientError.http(h.statusCode) }
        return data
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
        let (responseData, response) = try await session.data(for: request, delegate: NoRedirects())
        guard let response = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else { throw ClientError.http(response.statusCode) }
        return try APIJSON.decoder().decode(JSONValue.self, from: responseData)
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
}
private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
