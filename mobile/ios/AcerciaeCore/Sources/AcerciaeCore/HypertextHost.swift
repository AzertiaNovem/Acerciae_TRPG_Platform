import Foundation

// Interactive messages: what the iOS app decides around a card besides the card's own logic (Hypertext.swift) and the
// pipeline (HypertextPipeline.swift, HypertextStore.swift). Who the viewer is in the card's window (HypertextCard.tsx),
// the pieces of a sentence a view styles, how the lines an action posted join the chat, and the rules of the engine's
// WebView host (App/HypertextEngine.swift). The SwiftUI and WebKit code cannot be tested here, so its decisions live here.
extension Hypertext {

    // MARK: - The viewer around a card

    /// The viewer in a card's window, read from the window as the window list gives it (`members`, `archived_at`).
    public struct Seat: Equatable, Sendable {
        public var member = false
        /// Their view of the window is paused (`visibility_paused`).
        public var paused = false
        public var archived = false
        /// Their character in the window, and its name there.
        public var characterId: String? = nil
        public var characterName: String? = nil
        public init() {}
    }
    public static func seat(window: JSONValue?, userId: String?) -> Seat {
        var seat = Seat()
        guard let window else { return seat }
        seat.archived = !(window["archived_at"].string ?? "").isEmpty
        guard let userId, !userId.isEmpty, let m = window["members"].array.first(where: { $0["user_id"].string == userId }) else { return seat }
        seat.member = true
        seat.paused = m["visibility_paused"] == .bool(true)
        seat.characterId = m["character_id"].string.flatMap { $0.isEmpty ? nil : $0 }
        seat.characterName = m["character_name"].string
        return seat
    }

    /// A card as this viewer meets it: what `present` needs, the viewer a script sees, and how its lines are posted.
    public struct Viewing: Equatable, Sendable {
        public var facts: CardFacts
        public var viewer: Viewer
        /// `say.character_id`: the composer's character when it is not the viewer's in the card's window.
        public var sayCharacterId: String?
        /// The name an in-character confirmation names ("Post as {name}: …"); nil: the account's name.
        public var characterName: String?
        /// The server's dice are on (`features.dice` is not false): off, every line a script posts is confirmed.
        public var dice: Bool
    }
    /// The viewer around one card of the open window. `speakAs`: the character the composer speaks as ("" or nil: none
    /// picked); `characters`: the channel's characters (`id`, `name`, `user_id`); `engine`: the engine can run here.
    public static func viewing(_ message: Message, doc: Doc, openWindow: String, window: JSONValue?, userId: String?, gm: Bool, speakAs: String?,
                               characters: [JSONValue], unavailable: Unavailable?, engine: Bool, dice: Bool, now: Date = Date()) -> Viewing {
        let seat = seat(window: window, userId: userId)
        let own = characters.filter { userId != nil && $0["user_id"].string == userId }.map(\.id).filter { !$0.isEmpty }
        let say = sayCharacter(speakAs: speakAs, windowCharacter: seat.characterId, ownCharacters: own)
        // The character's name from the channel's list, else the window's own name for the viewer's character there.
        let name = say.flatMap { s in characters.first { $0.id == s }.flatMap { $0["name"].string } ?? (s == seat.characterId ? seat.characterName : nil) }
        var facts = CardFacts()
        facts.recalled = message.recalled
        facts.history = message.chatWindowId != openWindow
        facts.unavailable = unavailable
        facts.archived = seat.archived
        facts.gm = gm
        facts.member = seat.member
        facts.paused = seat.paused
        facts.characterId = seat.characterId
        facts.engine = engine
        facts.now = now
        return Viewing(facts: facts, viewer: Viewer(gm: gm, actor: isActor(doc, gm: gm, characterId: seat.characterId), character: name),
                       sayCharacterId: sayCharacterToSend(say, windowCharacter: seat.characterId), characterName: name, dice: dice)
    }
    /// A spectator's view (and the demo): the card is drawn from its document alone, every control locked.
    public static func spectatorFacts(now: Date = Date()) -> CardFacts {
        var facts = CardFacts()
        facts.spectator = true
        facts.now = now
        return facts
    }

    // MARK: - Sentences with placeholders

    /// A piece of a translated sentence: its own text (`key` nil), or the value of a placeholder, isolated.
    public struct Segment: Equatable, Sendable {
        public let text: String
        public let key: String?
        public init(text: String, key: String?) { self.text = text; self.key = key }
    }
    /// A translated sentence cut at its placeholders, as `fill` reads them, so that a view can style a value (the line a
    /// confirmation names) the way the web's `Isolated` does. A placeholder without a value stays text as written.
    public static func segments(_ sentence: String, _ values: [String: String]) -> [Segment] {
        var out: [Segment] = [], text = "", rest = Substring(sentence)
        while let open = rest.firstIndex(of: "{") {
            text += rest[..<open]
            let after = rest[rest.index(after: open)...]
            if let close = after.firstIndex(of: "}"), case let name = String(after[..<close]), !name.isEmpty,
               name.unicodeScalars.allSatisfy({ $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_") }), let value = values[name] {
                if !text.isEmpty { out.append(Segment(text: text, key: nil)); text = "" }
                out.append(Segment(text: isolate(value), key: name))
                rest = after[after.index(after: close)...]
            } else {
                text += "{"; rest = after
            }
        }
        text += rest
        if !text.isEmpty { out.append(Segment(text: text, key: nil)) }
        return out
    }

    // MARK: - Lines an action posted

    /// The open window's chat once the lines an action posted are in it, in `seq` order. A line of another channel or
    /// window is left to that window's own refresh, and a line already there (its push came first) is kept as it is.
    public static func mergeLines(_ messages: [Message], _ lines: [Message], channel: String, window: String) -> [Message] {
        let known = Set(messages.map(\.id))
        let fresh = lines.filter { line in
            !known.contains(line.id) && (line.channelId ?? channel) == channel && (line.chatWindowId ?? window) == window
        }
        guard !fresh.isEmpty else { return messages }
        var seen = Set<String>()
        return (messages + fresh.filter { seen.insert($0.id).inserted }).sorted { $0.seq < $1.seq }
    }

    // MARK: - The engine's WebView host

    /// The rules of App/HypertextEngine.swift, the hidden WKWebView that runs the committed bundle
    /// (mobile/contracts/hypertext, mobile/contracts/INTEGRATION.md "iOS sandbox").
    public enum EngineHost {
        /// The bundle's folder in the app (a folder resource) and its page.
        public static let folder = "hypertext", page = "hypertext-engine"
        public static let ruleListIdentifier = "acerciae-hypertext-engine-1"
        /// WKContentRuleList rules: every load is blocked, then the engine's own file: assets are let through, and so is
        /// the blob: URL of the worker the bundle starts from its own source. WebKit checks a worker's script load
        /// against the list like any subresource and ".*" matches a blob: URL, so it is named here; a blob: URL only
        /// names data the page itself made, so no network can be reached through it. The page's CSP (default-src
        /// 'none') blocks the same loads a second time. Read access is limited to the bundle's folder, so a file: load
        /// reaches nothing else.
        public static let contentRules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^file:"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}}]"#
        /// Loading the page and waiting for `MobileHypertext.ready`, together: a cold WebKit process can take long to
        /// start (LocalStudioEngine waits as long).
        public static let loadTimeout = 60.0
        /// The view is dropped after this long without a run.
        public static let idle = 120.0
        /// The function bodies the host calls with callAsyncJavaScript. Each always gives a string (never undefined or
        /// null): the bundle's version once it is ready ("" if it never is), and a run's result JSON.
        public static let readyScript = """
        const end = Date.now() + 60000;
        while (Date.now() < end) {
          if (typeof MobileHypertext === 'object' && MobileHypertext !== null && MobileHypertext.ready === true) return String(MobileHypertext.version);
          await new Promise(function (resolve) { setTimeout(resolve, 25); });
        }
        return '';
        """
        public static let runScript = "return String(await MobileHypertext.run(json));"
        /// The argument name `runScript` reads the request from.
        public static let runArgument = "json"
        /// The host's own backstop for one run. The bundle answers `timeout` itself after 1 s (5 s while a new worker
        /// starts), counted from when it starts the run; this mark comes later, so that answer normally comes first.
        public static func runTimeout(warm: Bool) -> Double { warm ? Hypertext.engineTimeout + 1.5 : Hypertext.engineColdTimeout + 3 }
        /// Whether the bundle starts a new worker after this result, so the next run starts cold: it ended its worker
        /// (`timeout`) or the worker stopped (`engine`). `MobileHypertext.ready` stays true then, so it cannot tell.
        /// A false alarm (an `engine` answer with the worker intact) only costs the longer backstop once.
        public static func restartsWorker(_ result: String) -> Bool {
            guard let v = try? JSONDecoder().decode(JSONValue.self, from: Data(result.utf8)) else { return false }
            return v["ok"] == .bool(false) && [ErrorCode.timeout, ErrorCode.engine].contains { v["error"]["code"] == .string($0.rawValue) }
        }
    }
}
