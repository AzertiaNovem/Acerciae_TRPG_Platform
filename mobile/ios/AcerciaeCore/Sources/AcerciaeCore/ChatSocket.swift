import Foundation

/// One event the chat stream pushed: `message.posted`, `message.recalled`, `window.changed`, … (docs/API.md).
public struct RealtimeEvent: Sendable {
    public let type: String
    public let channelId: String
    /// The message the event carries, when it decodes (a tombstone for `message.recalled`).
    public let message: Message?
    public let payload: JSONValue
    /// Nil for anything that is not an event object; a message that does not decode leaves `message` nil.
    public static func parse(_ text: String) -> RealtimeEvent? {
        let data = Data(text.utf8)
        guard let payload = try? JSONDecoder().decode(JSONValue.self, from: data), case .object = payload,
              let frame = try? APIJSON.decoder().decode(Frame.self, from: data), let type = frame.type, !type.isEmpty else { return nil }
        return RealtimeEvent(type: type, channelId: frame.channelId ?? "", message: frame.message, payload: payload)
    }
    private struct Frame: Decodable {
        let type: String?, channelId: String?, message: Message?
        enum CodingKeys: String, CodingKey { case type, channelId, message }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = try? c.decodeIfPresent(String.self, forKey: .type)
            channelId = try? c.decodeIfPresent(String.self, forKey: .channelId)
            message = try? c.decodeIfPresent(Message.self, forKey: .message)
        }
    }
}

/// 1 s, doubling to 15 s: the pause before the next attempt after `failures` failed ones.
public func reconnectPause(_ failures: Int) -> Double { min(15, Double(1 << min(failures, 4))) }

/// The chat stream of the channel on screen. It signs in with a short-lived file token (the session token never goes
/// into a URL), subscribes, pings every 25 s, and after a drop reconnects with growing pauses (`reconnectPause`),
/// fetching a fresh token each time. Each subscription after the first calls `resync`: the app fetches what it missed
/// while the socket was down. Everything happens on the main actor.
@MainActor public final class ChatSocket {
    public struct Handlers {
        public var event: @MainActor (RealtimeEvent) -> Void
        /// Subscribed and receiving (true), or not (false).
        public var live: @MainActor (Bool) -> Void
        public var resync: @MainActor () -> Void
        public init(event: @escaping @MainActor (RealtimeEvent) -> Void, live: @escaping @MainActor (Bool) -> Void, resync: @escaping @MainActor () -> Void) {
            self.event = event; self.live = live; self.resync = resync
        }
    }
    private let address: BackendAddress
    private let fileToken: () async throws -> String
    private let handlers: Handlers
    private let session: URLSession
    private let pause: (Int) -> Double
    private var channel: String?
    private var generation = 0
    private var worker: Task<Void, Never>?
    private var task: URLSessionWebSocketTask?
    private var failures = 0
    private var subscribedBefore = false
    public private(set) var live = false

    public init(address: BackendAddress, fileToken: @escaping () async throws -> String, handlers: Handlers,
                session: URLSession = .shared, pause: @escaping (Int) -> Double = reconnectPause) {
        self.address = address; self.fileToken = fileToken; self.handlers = handlers; self.session = session; self.pause = pause
    }

    /// Follows `channelId`'s stream (nil closes it). Following the channel it already follows changes nothing.
    public func follow(_ channelId: String?) {
        if channelId == channel && (channelId == nil || worker != nil) { return }
        channel = channelId; generation += 1; failures = 0; subscribedBefore = false
        worker?.cancel(); worker = nil
        task?.cancel(with: .goingAway, reason: nil); task = nil
        setLive(false)
        guard let channelId else { return }
        let gen = generation
        worker = Task { [weak self] in
            var wait = 0.0
            while !Task.isCancelled {
                if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
                guard let self, !Task.isCancelled, gen == self.generation else { return }
                await self.stream(gen, channelId)   // returns when the connection is gone
                guard !Task.isCancelled, gen == self.generation else { return }
                self.setLive(false)
                wait = self.pause(self.failures); self.failures += 1
            }
        }
    }
    public func close() { follow(nil) }

    /// Sends one pack (a `typing` flag, docs/API.md) on the subscribed stream; false, and nothing sent, while there is none.
    @discardableResult public func send(_ pack: JSONValue) -> Bool {
        guard live, let socket = task, let data = try? JSONEncoder().encode(pack) else { return false }
        socket.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
        return true
    }

    private func setLive(_ value: Bool) { guard live != value else { return }; live = value; handlers.live(value) }

    private func stream(_ gen: Int, _ channelId: String) async {
        guard let token = try? await fileToken(), gen == generation, !Task.isCancelled else { return }
        let socket = session.webSocketTask(with: address.websocket(.chat, token: token))
        task = socket
        socket.resume()
        let pinger = Task { [weak socket] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                socket?.sendPing { _ in }
            }
        }
        defer { pinger.cancel(); socket.cancel(with: .goingAway, reason: nil); if task === socket { task = nil } }
        do {
            let subscribe = try JSONEncoder().encode(["type": "subscribe", "channel_id": channelId])
            try await socket.send(.string(String(decoding: subscribe, as: UTF8.self)))
            while !Task.isCancelled {
                let frame = try await socket.receive()
                guard gen == generation else { return }
                let text: String
                switch frame {
                case .string(let value): text = value
                case .data(let value): text = String(decoding: value, as: UTF8.self)
                @unknown default: continue
                }
                guard let event = RealtimeEvent.parse(text) else { continue }
                switch event.type {
                case "subscribed":
                    failures = 0; setLive(true)
                    if subscribedBefore { handlers.resync() }
                    subscribedBefore = true
                case "hello", "pong": break
                default: handlers.event(event)
                }
            }
        } catch { return }
    }
}
