import XCTest
import SwiftUI
import AcerciaeCore
@testable import Acerciae

@MainActor final class ChatIllustrationTests: XCTestCase {
    func testPictureRendersWithoutBlockingChatAndRecallRemovesMemoryAndDisk() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let png = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 500)).pngData { ctx in
            UIColor.systemIndigo.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 800, height: 500))
            UIColor.systemTeal.setFill(); ctx.fill(CGRect(x: 0, y: 300, width: 800, height: 200))
        }
        PictureProtocol.reset(png)
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [PictureProtocol.self]
        let client = BackendClient(address: try BackendAddress("https://picture-ui.test"), session: URLSession(configuration: configuration), assets: AssetDiskCache(directory: directory))
        let session = try APIJSON.decoder().decode(Session.self, from: Data(#"{"token":"fixture","user":{"id":"reader","username":"reader","display_name":"Reader"}}"#.utf8))
        let model = AppModel(client: client, session: session)
        model.channelId = "channel"; model.windowId = "window"
        let message = try APIJSON.decoder().decode(Message.self, from: Data(#"{"id":"picture","channel_id":"channel","media_asset_id":"asset","content":"🖼️ 海边的黄昏","author_name":"GM","kind":"ooc","seq":1}"#.utf8))
        let key = ChatIllustrations.key(server: model.endpoint, account: "reader", channel: "channel", message: "picture")
        let controller = UIHostingController(rootView: ChatIllustration(message: message, model: model).padding(20))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene); window.overrideUserInterfaceStyle = .dark
        window.rootViewController = controller; window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKeyAndVisible() }
        model.draft = "Typing while the picture loads"
        XCTAssertFalse(model.busy)
        // A fresh CI simulator initializes networking and ImageIO on the first image request.
        let deadline = Date().addingTimeInterval(30)
        while ArtworkImages.cached(key) == nil && Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        _ = try XCTUnwrap(ArtworkImages.cached(key), "Illustration did not finish loading; requests: \(PictureProtocol.calls), responses: \(PictureProtocol.responses)")
        XCTAssertEqual(PictureProtocol.calls, 1)
        XCTAssertEqual(model.draft, "Typing while the picture loads"); XCTAssertFalse(model.busy)
        try await Task.sleep(for: .milliseconds(100))
        let screenshot = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: screenshot); attachment.name = "Chat illustration on iPhone"; attachment.lifetime = .keepAlways; add(attachment)
        let diskKey = "https://picture-ui.test/api/channels/channel/messages/picture/image"
        XCTAssertNotNil(AssetDiskCache(directory: directory).get(diskKey))
        let event = try XCTUnwrap(RealtimeEvent.parse(#"{"type":"message.recalled","channel_id":"channel","message":{"id":"picture","channel_id":"channel","content":"","author_name":"GM","kind":"ooc","seq":1,"recalled_at":"2026-11-07T00:00:00Z"}}"#))
        model.onPush(event)
        XCTAssertNil(ArtworkImages.cached(key))
        let removed = Date().addingTimeInterval(3)
        while AssetDiskCache(directory: directory).get(diskKey) != nil && Date() < removed { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertNil(AssetDiskCache(directory: directory).get(diskKey))
    }
}

private final class PictureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var png = Data()
    private static var count = 0
    private static var completed = 0
    static var calls: Int { lock.lock(); defer { lock.unlock() }; return count }
    static var responses: Int { lock.lock(); defer { lock.unlock() }; return completed }
    static func reset(_ data: Data) { lock.lock(); png = data; count = 0; completed = 0; lock.unlock() }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "picture-ui.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let data = Self.png; Self.count += 1; Self.lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png", "Cache-Control": "private, max-age=86400"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
            Self.lock.lock(); Self.completed += 1; Self.lock.unlock()
        }
    }
    override func stopLoading() {}
}
