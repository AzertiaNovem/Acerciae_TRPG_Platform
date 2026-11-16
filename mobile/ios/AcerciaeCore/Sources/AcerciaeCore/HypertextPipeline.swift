import Foundation

// Interactive messages: what a viewer's app decides around a card, ported from frontend/src/store/hypertext.ts (the
// action pipeline's pure parts) and frontend/src/components/HypertextCard.tsx (why controls are locked, what the
// footer says). HypertextStore runs the pipeline with these; the app draws what `present` answers. Sentences are the
// catalog's keys (frontend/src/i18n/catalog.json, packaged by mobile/scripts/sync-localizations.py): translate them,
// then fill their placeholders with `fill`.
extension Hypertext {

    // MARK: - Routes and pushes

    /// One card in `GET /channels/{c}/hypertext`: this viewer's own state and version (nil and 0 before their first save).
    public struct StatusItem: Decodable, Equatable, Sendable {
        public var messageId: String
        public var closesAt: String?
        public var closedAt: String?
        public var closed: Bool
        public var state: State?
        public var version: Int
        /// Actions with effects the viewer may still take.
        public var runsLeft: Int?
        public init(messageId: String, closesAt: String? = nil, closedAt: String? = nil, closed: Bool = false, state: State? = nil, version: Int = 0, runsLeft: Int? = nil) {
            self.messageId = messageId; self.closesAt = closesAt; self.closedAt = closedAt; self.closed = closed; self.state = state; self.version = version; self.runsLeft = runsLeft
        }
        private enum CodingKeys: String, CodingKey { case messageId, closesAt, closedAt, closed, state, version, runsLeft }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            func value(_ k: CodingKeys) -> JSONValue? { (try? c.decodeIfPresent(JSONValue.self, forKey: k)) ?? nil }
            messageId = value(.messageId)?.string ?? ""
            closesAt = value(.closesAt)?.string
            closedAt = value(.closedAt)?.string
            closed = value(.closed)?.bool ?? false
            state = value(.state)?.objectValue
            version = Hypertext.integer(value(.version), limit: 9e15) ?? 0
            runsLeft = Hypertext.integer(value(.runsLeft), limit: 9e15)
        }
    }
    public struct Status: Decodable, Equatable, Sendable {
        /// False: the server's operator turned the feature off.
        public var enabled: Bool
        /// The readable, not recalled cards among those asked about; one left out is gone.
        public var items: [StatusItem]
        public init(enabled: Bool, items: [StatusItem]) { self.enabled = enabled; self.items = items }
        private enum CodingKeys: String, CodingKey { case enabled, items }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            enabled = ((try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? nil) ?? false
            items = ((try? c.decodeIfPresent([StatusItem].self, forKey: .items)) ?? nil) ?? []
        }
    }
    /// A saved state (`PUT …/hypertext/state`, and the `state` of an action's answer).
    public struct Saved: Decodable, Equatable, Sendable {
        public var state: State?
        public var version: Int
        public init(state: State?, version: Int) { self.state = state; self.version = version }
        private enum CodingKeys: String, CodingKey { case state, version }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = ((try? c.decodeIfPresent(JSONValue.self, forKey: .state)) ?? nil)?.objectValue
            version = Hypertext.integer((try? c.decodeIfPresent(JSONValue.self, forKey: .version)) ?? nil, limit: 9e15) ?? 0
        }
    }
    /// The answer to `POST …/hypertext/act`.
    public struct ActResult: Decodable, Equatable, Sendable {
        public var interactionId: String
        public var replayed: Bool
        /// A later effect failed: the lines before it were posted.
        public var partial: Bool
        /// The lines it posted, as the viewer may read them (a GM-only reply or a hidden roll is left out), to put into the
        /// chat at once (de-duplicated there with their pushes by id).
        public var messages: [Message]
        public var state: Saved?
        public init(interactionId: String = "", replayed: Bool = false, partial: Bool = false, messages: [Message] = [], state: Saved? = nil) {
            self.interactionId = interactionId; self.replayed = replayed; self.partial = partial; self.messages = messages; self.state = state
        }
        private enum CodingKeys: String, CodingKey { case interactionId, replayed, partial, results, state }
        private struct Line: Decodable {
            let message: Message?
            private enum CodingKeys: String, CodingKey { case message }
            init(from decoder: Decoder) throws { message = ((try? decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(Message.self, forKey: .message)) ?? nil) }
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            interactionId = ((try? c.decodeIfPresent(String.self, forKey: .interactionId)) ?? nil) ?? ""
            replayed = ((try? c.decodeIfPresent(Bool.self, forKey: .replayed)) ?? nil) ?? false
            partial = ((try? c.decodeIfPresent(Bool.self, forKey: .partial)) ?? nil) ?? false
            messages = (((try? c.decodeIfPresent([Line].self, forKey: .results)) ?? nil) ?? []).compactMap(\.message)
            state = (try? c.decodeIfPresent(Saved.self, forKey: .state)) ?? nil
        }
    }
    /// The answer to `POST …/hypertext/close`.
    public struct Closed: Decodable, Equatable, Sendable {
        public var closesAt: String?
        public var closedAt: String?
        public init(closesAt: String?, closedAt: String?) { self.closesAt = closesAt; self.closedAt = closedAt }
    }
    public struct StatePush: Equatable, Sendable {
        public let messageId: String
        public let state: State?
        public let version: Int
    }
    public struct ClosedPush: Equatable, Sendable {
        public let messageId: String
        public let closedAt: String
    }
    /// The cards among loaded lines whose status is asked for: every interactive message not recalled.
    public static func cardIds(_ messages: [Message]) -> [String] { messages.filter { $0.isHypertext && !$0.recalled }.map(\.id) }

    // MARK: - Sentences (catalog keys)

    public enum Sentence {
        public static let update = "Update the app to use this message."
        public static let failed = "This message's action failed."
        public static let unsent = "This message's action could not be sent. Check your connection."
        public static let unsaved = "Your change could not be saved."
        public static let partial = "Part of this action could not be posted."
        public static let noEngine = "Interactive actions are unavailable on this device."
        public static let working = "Working…"
        public static let usesLeft = "Uses left: {n}"
        public static let usedUp = "You already used this."
        public static let posts = "Posts:"
        public static let postsOoc = "Posts (out of character):"
        public static let postAs = "Post as {name}: {text}"
        public static let postAsOoc = "Post as {name} (out of character): {text}"
        public static let confirm = "Confirm"
        public static let sheet = "This changes your character sheet."
        public static let post = "Post"
        public static let cancel = "Cancel"
        public static let scriptDetails = "Script details"
        public static let gmOnly = "GM only"
        public static let line = "Line {n}"
        public static let close = "Close"
        public static let closeHint = "Stop everyone from using this message"
        public static let choose = "Choose…"
        public static let send = "Send"
        public static let atMost = "At most {n} characters."
        public static let inputNotice = "Anything you type here may be shared in the chat."
        public static let pill = "Interactive message"
        public static let via = "via interactive message"
        public static let viaHint = "Posted from an interactive message"
        public static let answering = "answering {name}"
    }
    /// The sentence for a refusal code; other codes show the server's own message.
    public static let errorSentences: [String: String] = [
        "hypertext_closed": "This message is closed.",
        "runs_exhausted": "You already used this.",
        "reply_exhausted": "This answer is no longer available.",
        "rate_limited": "Too many actions. Try again in a moment.",
        "not_an_actor": "This message is for other characters.",
        "hypertext_command_not_allowed": "This message cannot post that command for you.",
        "sender_unavailable": "This message's sender can no longer answer.",
        "state_conflict": "This message changed on another device.",
        "interaction_in_progress": "An action on this message is still being posted. Try again in a moment.",
        "feature_disabled": "Interactive messages are turned off on this server.",
    ]
    /// A known code in the catalog's words, else the server's message, else "This message's action failed.".
    public static func errorText(code: String?, message: String?) -> String {
        if let code, let known = errorSentences[code] { return known }
        if let message, !message.isEmpty { return message }
        return Sentence.failed
    }
    public static func errorText(_ r: Refusal) -> String { errorText(code: r.code, message: r.message) }

    /// U+2068 … U+2069 around a card or user string, so it cannot reorder the sentence, the frame or the pill around it
    /// (the web's <bdi>).
    public static func isolate(_ s: String) -> String { "\u{2068}" + s + "\u{2069}" }
    /// A translated sentence with its {placeholders} filled (the apps' `tr` has none), each value isolated; an
    /// unknown placeholder is kept as written.
    public static func fill(_ sentence: String, _ values: [String: String], isolated: Bool = true) -> String {
        var out = "", rest = Substring(sentence)
        while let open = rest.firstIndex(of: "{") {
            out += rest[..<open]
            let after = rest[rest.index(after: open)...]
            if let close = after.firstIndex(of: "}"), case let name = String(after[..<close]), !name.isEmpty,
               name.unicodeScalars.allSatisfy({ ($0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_")) }), let value = values[name] {
                out += isolated ? isolate(value) : value
                rest = after[after.index(after: close)...]
            } else {
                out += "{"; rest = after
            }
        }
        return out + rest
    }

    // MARK: - Outcomes of a card request

    public enum Unavailable: String, Sendable { case missing, disabled }
    public enum Outcome: String, Sendable { case retry, missing, disabled, gone, confirm, conflict, refetch, fail }
    /// What a failed card request said. `status` 0: no answer (the network; also a cancelled request). `apiResponse`:
    /// the body was the API's own JSON; a 404 without it is a server that has no such route.
    public struct Refusal: Equatable, Sendable {
        public let status: Int
        public let apiResponse: Bool
        public let code: String
        public let body: JSONValue
        public init(status: Int, apiResponse: Bool = true, code: String = "", body: JSONValue = .null) {
            self.status = status; self.apiResponse = apiResponse; self.code = code; self.body = body
        }
        public init(_ error: Error) {
            switch error as? ClientError {
            case .refused(let status, let body)?: self.init(status: status, code: body["error"].text, body: body)
            case .http(let status)?: self.init(status: status)
            case .gateway(let status)?: self.init(status: status, apiResponse: false)
            case .rules(let status, let message)?: self.init(status: status, body: .object(["message": .string(message)]))
            case .pointsRule(let message)?: self.init(status: 400, code: "points_rule", body: .object(["message": .string(message)]))
            // A success whose body is not what the route answers: the action may have been posted, so it is not tried again.
            case .invalidResponse?: self.init(status: 200, apiResponse: false, code: "invalid_response")
            case .invalidAddress?, .insecureAddress?: self.init(status: 400, apiResponse: false)
            case nil: self.init(status: 0, apiResponse: false)
            }
        }
        public var message: String? { body["message"].string }
    }
    /// What to do about a failed request to a card route. No status: the network (or a timeout, 408): try again, as for a
    /// 5xx or, for an action, one still being posted under the same id. A 404 that is not the API's own answer, or a 405:
    /// the route is not there (an older server). The API's 404: the card is gone (recalled, or no longer readable).
    public static func classify(_ r: Refusal) -> Outcome {
        if r.status == 0 || r.status == 408 || r.status >= 500 { return .retry }
        if r.status == 405 || (r.status == 404 && !r.apiResponse) { return .missing }
        if r.status == 403 && r.code == "feature_disabled" { return .disabled }
        if r.status == 404 { return .gone }
        if r.status == 428 { return .confirm }
        if r.status == 409 { return r.code == "interaction_in_progress" ? .retry : r.code == "state_conflict" ? .conflict : .refetch }
        return .fail
    }
    public static func classify(_ error: Error) -> Outcome { classify(Refusal(error)) }
    /// The stored state and version a 409 state_conflict carries (nil and 0 when there is none).
    public static func conflictState(_ r: Refusal) -> Saved { Saved(state: r.body["state"].objectValue, version: integer(r.body["version"], limit: 9e15) ?? 0) }
    /// The confirmation a 428 asks for: the server's `text` (else the say's), with the sheet warning unless `sheet` is
    /// false (the server's dice are off: the line posts as plain text). Nil when the body has no say.
    public static func confirmFrom(_ r: Refusal, body: JSONValue) -> Confirm? {
        guard case .object(let say) = body["say"] else { return nil }
        let text = r.body["text"].string ?? say["text"]?.text ?? ""
        return Confirm(text: text, kind: SayKind(rawValue: say["kind"]?.text ?? "") ?? .ic, sheet: r.body["sheet"] != .bool(false))
    }
    /// Pauses before an action or a save is tried again (seconds), then it is given up.
    public static let retryPauses: [Double] = [0.6, 1.8, 4.5]

    // MARK: - State and requests

    /// Whether two states hold the same values (key order aside; sets are kept in schema order on both sides).
    public static func sameState(_ a: State?, _ b: State?) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        guard a.count == b.count else { return false }
        return a.allSatisfy { k, v in
            guard let w = b[k] else { return false }
            if case .array(let x) = v {
                guard case .array(let y) = w, x.count == y.count else { return false }
                return zip(x, y).allSatisfy { strictlyEqual($0, $1) }
            }
            return strictlyEqual(v, w)
        }
    }
    private static func strictlyEqual(_ a: JSONValue, _ b: JSONValue) -> Bool {
        switch (a, b) {
        case (.array, _), (_, .array), (.object, _), (_, .object): false
        default: same(a, b)   // by code unit, as on the web
        }
    }
    /// The state a card is drawn with: the draft, else the server's copy over the defaults.
    public static func shownState(_ doc: Doc, draft: State?, state: State?) -> State { draft ?? overlay(doc, state: state) }
    /// A new id for one action, reused by each of its retries and by its resend after a confirmation.
    public static func newInteractionId() -> String { UUID().uuidString.lowercased() }
    /// The /act request for the effects of one action. `characterId`: the character the composer speaks as, sent only
    /// when it is not the viewer's character in the card's window (the server takes that one otherwise).
    public static func actBody(interactionId: String, node: String, effects: [Effect], state: State, baseVersion: Int, confirmed: Bool = false, characterId: String? = nil) -> JSONValue {
        var body: [String: JSONValue] = ["interaction_id": .string(interactionId), "node": .string(node), "base_version": .number(Double(baseVersion)), "state": .object(state)]
        for e in effects {
            switch e {
            case .say(let text, let kind):
                var say: [String: JSONValue] = ["text": .string(text), "kind": .string(kind.rawValue)]
                if let characterId, !characterId.isEmpty { say["character_id"] = .string(characterId) }
                if confirmed { say["confirmed"] = .bool(true) }
                body["say"] = .object(say)
            case .reply(let id, let slots): body["reply"] = .object(["id": .string(id), "slots": .object(slots)])
            }
        }
        return .object(body)
    }
    /// The same request, its say confirmed by the viewer (the resend after a 428 keeps the interaction id).
    public static func confirmed(_ body: JSONValue) -> JSONValue {
        guard case .object(var o) = body, case .object(var say)? = o["say"] else { return body }
        say["confirmed"] = .bool(true); o["say"] = .object(say)
        return .object(o)
    }
    /// The confirmation a script's effects need before they are sent. With the server's dice off a dot command is plain
    /// text, so any say is confirmed (and changes no sheet).
    public static func confirmOf(effects: [Effect], confirm: Confirm?, dice: Bool = true) -> Confirm? {
        if dice { return confirm }
        for e in effects { if case .say(let text, let kind) = e { return Confirm(text: text, kind: kind) } }
        return nil
    }

    // MARK: - One card's entry

    /// Everything a viewer's app holds about one card (store/hypertext.ts CardEntry), with the transitions the pipeline
    /// makes. A draft is what is shown instead of the server's copy until it is saved, adopted or reverted.
    public struct CardEntry: Equatable, Sendable {
        public var channelId: String
        /// The status arrived; controls stay disabled ("Loading…") until then.
        public var loaded = false
        public var stale = false
        public var fetching = false
        /// Left out of the status: recalled or no longer readable (drawn closed).
        public var gone = false
        public var closesAt: String? = nil
        public var closedAt: String? = nil
        public var closed = false
        /// The server's copy of this viewer's state (nil before their first save).
        public var state: State? = nil
        public var version = 0
        public var runsLeft: Int? = nil
        public var draft: State? = nil
        /// An action of this card is under way on this device.
        public var pending = false
        /// One short sentence for the viewer: a catalog key, or the server's own words.
        public var error: String? = nil
        /// The last script failure (its details are shown to GMs only).
        public var failure: EngineError? = nil
        /// The last run's log() lines (GMs only) and notify() notes (this viewer only, never sent).
        public var logs: [String] = []
        public var notices: [String] = []
        /// A line waiting for the viewer's confirmation.
        public var confirm: Confirm? = nil
        public init(channelId: String) { self.channelId = channelId }

        public var spent: Bool { runsLeft == 0 }
        /// The server's copy, when it is newer than the one held (or as new, with `orEqual`: a status read again, or the
        /// conflict of an action); a draft that now equals it has nothing left to save. False when it was not adopted.
        @discardableResult public mutating func adopt(_ state: State?, version: Int, orEqual: Bool = false) -> Bool {
            guard version > self.version || (orEqual && version == self.version) else { return false }
            self.state = state; self.version = version
            if let draft, Hypertext.sameState(draft, state) { self.draft = nil }
            return true
        }
        /// The state shown from now on: a draft only while it differs from the server's copy. While a save is on its way
        /// (`saving`) the draft always stays: a change back to the server's copy must still be saved over the one being
        /// sent.
        public mutating func setDraft(_ state: State, doc: Doc, saving: Bool) {
            draft = !saving && Hypertext.sameState(state, Hypertext.overlay(doc, state: self.state)) ? nil : state
        }
        /// A status item for this card.
        public mutating func apply(_ item: StatusItem) {
            fetching = false; loaded = true; gone = false
            closesAt = item.closesAt; closedAt = item.closedAt; closed = item.closed; runsLeft = item.runsLeft
            adopt(item.state, version: item.version, orEqual: true)
        }
        /// An action that ends without effect: what was shown before it comes back.
        public mutating func revert(to prev: State?, error: String?) { pending = false; draft = prev; confirm = nil; self.error = error }
        /// An action the server answered: its state adopted when newer, one run used, partial results said.
        public mutating func finish(_ result: ActResult) {
            if let s = result.state { adopt(s.state, version: s.version) }
            pending = false; draft = nil
            runsLeft = runsLeft.map { Swift.max(0, $0 - 1) }
            error = result.partial ? Sentence.partial : nil
        }
    }

    // MARK: - Drawing a card (HypertextCard.tsx)

    /// Why every control of a card is disabled: the card's own lock reasons, plus what the app knows (the viewer is not
    /// in the window; the server has no interactive messages, or has them turned off).
    public enum CardReason: String, Sendable {
        case spectator, recalled, history, missing, disabled, closed, archived, paused, member, notActor = "not_actor", loading
        /// The lock `resolve` draws with.
        public var lock: LockReason {
            switch self {
            case .member, .notActor: .notActor
            case .missing, .disabled, .closed: .closed
            case .spectator: .spectator
            case .recalled: .recalled
            case .history: .history
            case .archived: .archived
            case .paused: .paused
            case .loading: .loading
            }
        }
        /// The footer's sentence (a catalog key).
        public var sentence: String {
            switch self {
            case .closed: "This message is closed."
            case .recalled: "This message was recalled."
            case .notActor: "This message is for other characters."
            case .spectator: "Spectators cannot use interactive messages."
            case .history: "This message belongs to an earlier chat window."
            case .archived: "This window is archived."
            case .paused: "Your participation in this window is paused."
            case .loading: "Loading…"
            case .member: "Join this chat window to use this message."
            case .missing: "This server does not support interactive messages yet."
            case .disabled: "Interactive messages are turned off on this server."
            }
        }
    }
    /// Who may act: GMs, and the actors by their character in the card's window, compared without case (as the server
    /// checks); a card without actors lets everyone act.
    public static func isActor(_ doc: Doc, gm: Bool, characterId: String?) -> Bool {
        guard !gm, let actors = doc.actors, !actors.isEmpty else { return true }
        guard let characterId, !characterId.isEmpty else { return false }
        return actors.contains { same($0.lowercased(), characterId.lowercased()) }
    }
    /// The character a line as the viewer speaks as: the composer's "Speak as" pick, else their character in the card's
    /// window, else (not cast in the window) their first own character, as the composer does.
    public static func sayCharacter(speakAs: String?, windowCharacter: String?, ownCharacters: [String]) -> String? {
        if let speakAs, !speakAs.isEmpty { return speakAs }
        if let windowCharacter, !windowCharacter.isEmpty { return windowCharacter }
        return ownCharacters.first
    }
    /// `say.character_id` for an action: sent only when it is not the viewer's character in the card's window.
    public static func sayCharacterToSend(_ sayCharacter: String?, windowCharacter: String?) -> String? {
        guard let sayCharacter, !sayCharacter.isEmpty, sayCharacter != windowCharacter else { return nil }
        return sayCharacter
    }
    /// The confirmation row: "Post as {name}: {text}" with the character's name, or, out of character, "Post as {name}
    /// (out of character): {text}" with the account's name. Translate the sentence, then fill it.
    public static func confirmLine(_ c: Confirm, characterName: String?, accountName: String) -> (sentence: String, values: [String: String]) {
        let ooc = c.kind == .ooc
        return (ooc ? Sentence.postAsOoc : Sentence.postAs, ["name": (ooc ? nil : characterName) ?? accountName, "text": c.text])
    }

    /// What the app knows about a card as it draws it.
    public struct CardFacts: Equatable, Sendable {
        /// A spectator's view or the demo: drawn read-only from the document, no status, no engine.
        public var spectator = false
        public var recalled = false
        /// `message.chatWindowId` is not the open window (fork history).
        public var history = false
        public var unavailable: Unavailable? = nil
        public var archived = false
        public var gm = false
        /// The viewer is a member of the card's window, and whether their view of it is paused.
        public var member = true
        public var paused = false
        /// Their character in the card's window.
        public var characterId: String? = nil
        /// The engine can run here (a control with `on` is disabled without it): false without an engine host, and
        /// once the store's `engineMissing` is set.
        public var engine = true
        public var now = Date()
        public init() {}
    }
    /// A card as drawn: the lock, the state and nodes, and what the footer shows.
    public struct Card: Equatable, Sendable {
        public let reason: CardReason?
        public let actor: Bool
        public let closed: Bool
        public let state: State
        /// Every node in document order (`Node.index`).
        public let resolved: [Resolved]
        /// Per node, by `Node.index`: disabled for real (locked, enable_if, a script control without the engine, a
        /// button that posts once no run is left).
        public let off: [Bool]
        /// An action is under way or waits for a confirmation: the other controls look and act disabled meanwhile.
        public let busy: Bool
        /// Any control runs the script; any control can post (a script control, or an act that says or replies).
        public let scriptControls: Bool
        public let posting: Bool
        /// The footer: the reason's sentence; else "Interactive actions are unavailable on this device."; "Working…";
        /// "Uses left: {n}"; "You already used this."; and "Close" for GMs.
        public let noEngine: Bool
        public let working: Bool
        public let usesLeft: Int?
        public let usedUp: Bool
        public let showClose: Bool
        public let showFooter: Bool
        /// When the card closes by itself, while that is still ahead: draw it again then.
        public let closesAt: Date?
        public var lock: LockReason? { reason?.lock }
    }
    public static func present(_ doc: Doc, entry: CardEntry?, facts: CardFacts) -> Card {
        let entry = facts.spectator ? nil : entry
        let closesText = entry?.closesAt ?? doc.closesAt
        let closesAt = closesText.flatMap(time)
        let closed = !(entry?.closedAt ?? "").isEmpty || entry?.closed == true || entry?.gone == true || closesAt.map { $0 <= facts.now } == true
        let actor = isActor(doc, gm: facts.gm, characterId: facts.characterId)
        let reason: CardReason? = facts.spectator ? .spectator
            : facts.recalled ? .recalled
            : facts.history ? .history
            : facts.unavailable == .missing ? .missing
            : facts.unavailable == .disabled ? .disabled
            : closed ? .closed
            : facts.archived ? .archived
            : !facts.gm && facts.member && facts.paused ? .paused
            : !facts.gm && !facts.member ? .member
            : !actor ? .notActor
            : entry?.loaded != true ? .loading
            : nil
        let state = shownState(doc, draft: entry?.draft, state: entry?.state)
        let resolved = resolve(doc, state, reason?.lock)
        let spent = entry?.spent == true
        let scriptControls = doc.nodes.contains { $0.on != nil }
        let posting = scriptControls || doc.nodes.contains { $0.postsSomething }
        let off = resolved.map { r in r.disabled || (r.node.on != nil && !facts.engine) || (spent && r.node.postsSomething) }
        let busy = entry?.pending == true || entry?.confirm != nil
        let usesLeft = reason == nil && posting && doc.runsPerViewer > 1 && (entry?.runsLeft ?? 0) != 0 ? entry?.runsLeft : nil
        let usedUp = reason == nil && posting && spent
        let noEngine = reason == nil && scriptControls && !facts.engine
        let gmTools = facts.gm && !facts.spectator
        let showClose = gmTools && !closed && reason != .history && facts.unavailable == nil && entry?.loaded == true
        return Card(reason: reason, actor: actor, closed: closed, state: state, resolved: resolved, off: off, busy: busy, scriptControls: scriptControls, posting: posting,
                    noEngine: noEngine, working: reason == nil && entry?.pending == true && entry?.confirm == nil, usesLeft: usesLeft, usedUp: usedUp, showClose: showClose,
                    showFooter: reason != nil || noEngine || usesLeft != nil || usedUp || busy || gmTools,
                    closesAt: closesAt.flatMap { $0 > facts.now ? $0 : nil })
    }

    /// An ISO 8601 time as the server writes it ("2026-11-14T14:25:47.149433+00:00", "…Z"; any fraction), nil when it
    /// is not one (Date.parse giving NaN: the card is not closed by it).
    public static func time(_ s: String) -> Date? {
        let u = Array(s.utf8)
        func num(_ a: Int, _ n: Int) -> Int? {
            guard a + n <= u.count else { return nil }
            var v = 0
            for i in a..<(a + n) { guard (0x30...0x39).contains(u[i]) else { return nil }; v = v * 10 + Int(u[i] - 0x30) }
            return v
        }
        guard let year = num(0, 4), u.count >= 19, u[4] == 0x2d, let month = num(5, 2), u[7] == 0x2d, let day = num(8, 2),
              u[10] == 0x54 || u[10] == 0x74 || u[10] == 0x20, let hour = num(11, 2), u[13] == 0x3a, let minute = num(14, 2), u[16] == 0x3a, let second = num(17, 2),
              (1...12).contains(month), (1...31).contains(day), hour < 24, minute < 60, second < 61 else { return nil }
        var i = 19, fraction = 0.0
        if i < u.count && u[i] == 0x2e {
            i += 1
            var scale = 0.1, digits = 0
            while i < u.count && (0x30...0x39).contains(u[i]) { fraction += Double(u[i] - 0x30) * scale; scale /= 10; i += 1; digits += 1 }
            guard digits > 0 else { return nil }
        }
        var offset = 0
        if i < u.count && (u[i] == 0x5a || u[i] == 0x7a) { i += 1 }
        else if i < u.count && (u[i] == 0x2b || u[i] == 0x2d) {
            let sign = u[i] == 0x2d ? -1 : 1
            guard let oh = num(i + 1, 2) else { return nil }
            var j = i + 3
            if j < u.count && u[j] == 0x3a { j += 1 }
            let om = num(j, 2) ?? 0
            if num(j, 2) != nil { j += 2 }
            offset = sign * (oh * 3600 + om * 60); i = j
        } else { return nil }
        guard i == u.count else { return nil }
        // Days from the civil date (proleptic Gregorian), as in Howard Hinnant's days_from_civil.
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        let days = era * 146097 + doe - 719468
        return Date(timeIntervalSince1970: Double(days * 86400 + hour * 3600 + minute * 60 + second - offset) + fraction)
    }
}

extension JSONValue {
    /// The object's fields, or nil when the value is not an object.
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
}
