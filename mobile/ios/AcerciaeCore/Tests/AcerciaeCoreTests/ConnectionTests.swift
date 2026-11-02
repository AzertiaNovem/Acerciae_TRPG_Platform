import XCTest
@testable import AcerciaeCore
final class ConnectionTests: XCTestCase {
    private func client(_ replies:[ProbeProtocol.Reply]) throws -> BackendClient {
        ProbeProtocol.reset(replies)
        let config=URLSessionConfiguration.ephemeral; config.protocolClasses=[ProbeProtocol.self]
        return BackendClient(address:try BackendAddress("https://network.test"),session:URLSession(configuration:config))
    }
    func testConfiguredServiceHealthWhenExplicitlyRequested() async throws {
        guard ProcessInfo.processInfo.environment["ACERCIAE_HEALTH_PROBE"] == "1" else { throw XCTSkip("Opt-in unauthenticated production health probe") }
        let c=BackendClient(address:try BackendAddress(ServiceConfiguration.backendRoot))
        for _ in 0..<6 { let result=try await c.health(); XCTAssertEqual(result.status,"ok"); XCTAssertEqual(result.db,"ok") }
    }
    func testReadRecoversFromDroppedConnectionAndGatewayWithoutLosingAuth() async throws {
        let c=try client([.failure(.networkConnectionLost),.http(503,"busy"),.http(200,#"[{"id":"s","name":"Server"}]"#)])
        let servers = try await c.servers(token:"test-only")
        XCTAssertEqual(servers.count,1)
        XCTAssertEqual(ProbeProtocol.requests.count,3)
        for r in ProbeProtocol.requests { XCTAssertEqual(r.value(forHTTPHeaderField:"Authorization"),"Bearer test-only"); XCTAssertEqual(r.value(forHTTPHeaderField:"Accept"),"application/json"); XCTAssertEqual(r.value(forHTTPHeaderField:"User-Agent"),"AcerciaeMobile/0.1 (iOS)") }
    }
    func testWriteIsNeverAutomaticallyReplayed() async throws {
        let c=try client([.http(503,"busy"),.http(200,"{}")])
        do { _=try await c.resource(["messages"],token:"test-only",body:.object([:])); XCTFail("Expected failure") } catch ClientError.gateway(503) {}
        XCTAssertEqual(ProbeProtocol.requests.count,1)
        let d=try client([.failure(.networkConnectionLost),.http(200,"{}")])
        do { _=try await d.resource(["messages"],token:"test-only",body:.object([:])); XCTFail("Expected failure") } catch let e as URLError { XCTAssertEqual(e.code,.networkConnectionLost) }
        XCTAssertEqual(ProbeProtocol.requests.count,1)
    }
    func testEdgeDenialIsNotAnApplicationLoginFailure() async throws {
        let c=try client([.http(401,"<html>Access denied</html>")])
        do { _=try await c.servers(token:"test-only"); XCTFail("Expected gateway error") } catch ClientError.gateway(401) {}
        XCTAssertEqual(ProbeProtocol.requests.count,1)
        let d=try client([.http(401,#"{"error":"unauthorized"}"#)])
        do { _=try await d.servers(token:"test-only"); XCTFail("Expected auth error") } catch ClientError.http(401) {}
    }
    func testMalformedSuccessfulResponseHasSpecificErrorAndNoRetry() async throws {
        let c=try client([.http(200,"<html>Proxy login</html>")])
        do { _=try await c.servers(token:"test-only"); XCTFail("Expected schema error") } catch ClientError.invalidResponse {}
        XCTAssertEqual(ProbeProtocol.requests.count,1)
    }
    func testRetriesAreBoundedAndCertificateFailuresAreNotRetried() async throws {
        let c=try client([.http(502,"bad gateway"),.http(502,"bad gateway"),.http(502,"bad gateway")])
        do { _=try await c.health(); XCTFail("Expected failure") } catch ClientError.gateway(502) {}
        XCTAssertEqual(ProbeProtocol.requests.count,3)
        let d=try client([.failure(.serverCertificateUntrusted)])
        do { _=try await d.health(); XCTFail("Expected TLS failure") } catch let e as URLError { XCTAssertEqual(e.code,.serverCertificateUntrusted) }
        XCTAssertEqual(ProbeProtocol.requests.count,1)
    }
    func testCancellationStopsRetryDelay() async throws {
        let c=try client([.http(503,"busy"),.http(200,#"{"status":"ok"}"#)])
        let task=Task { try await c.health() }
        while ProbeProtocol.requests.isEmpty { try await Task.sleep(for:.milliseconds(5)) }
        task.cancel()
        do { _=try await task.value; XCTFail("Expected cancellation") } catch is CancellationError {}
        XCTAssertEqual(ProbeProtocol.requests.count,1)
    }
}
private final class ProbeProtocol:URLProtocol,@unchecked Sendable {
    enum Reply { case http(Int,String), failure(URLError.Code) }
    private static let lock=NSLock()
    private static var queue:[Reply]=[]
    private static var recorded:[URLRequest]=[]
    static var requests:[URLRequest] { lock.lock(); defer { lock.unlock() }; return recorded }
    static func reset(_ replies:[Reply]) { lock.lock(); defer { lock.unlock() }; queue=replies; recorded=[] }
    override class func canInit(with request:URLRequest)->Bool { request.url?.host=="network.test" }
    override class func canonicalRequest(for request:URLRequest)->URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); Self.recorded.append(request); let next=Self.queue.isEmpty ? Reply.http(500,"Unexpected request") : Self.queue.removeFirst(); Self.lock.unlock()
        switch next {
        case .failure(let code): client?.urlProtocol(self,didFailWithError:URLError(code))
        case .http(let status,let body):
            client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:nil)!,cacheStoragePolicy:.notAllowed)
            client?.urlProtocol(self,didLoad:Data(body.utf8));client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
