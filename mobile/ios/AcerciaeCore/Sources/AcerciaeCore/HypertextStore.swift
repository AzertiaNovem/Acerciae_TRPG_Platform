import Foundation

/// Interactive messages of the open channel (a port of frontend/src/store/hypertext.ts): each card's status for this
/// viewer, what is shown before the server has it (a draft), and the action pipeline every client follows
/// (docs/HYPERTEXT.md, mobile/contracts/INTEGRATION.md "Interactive messages"):
/// - a control with no handler and no act changes the state, saved by a debounced PUT (coalesced per card);
/// - a button's declarative act gives the new state and its effects: /act, or a PUT when nothing is posted;
/// - an `on` handler runs the card's script in the engine, whose result is checked again here (validateOutput) and shown
///   at once (state and notices); a line that needs the viewer's confirmation waits for it (cancel reverts and sends
///   nothing); then /act, or a PUT when nothing is posted.
/// Each action has its own interaction id, reused by every retry of it: no answer, a 5xx or an action still being posted
/// is tried again 3 times with a growing pause, then the action reverts. 428 asks the viewer and sends the same action
/// again with `confirmed`; 409 adopts the server's state (from the refusal, or by fetching the status again); a 404/405
/// that is not the API's (an older server) and 403 feature_disabled mark the feature unavailable. One action per card is
/// under way at a time on this device, and saves and actions of a card go one after the other, so each starts from the
/// version the last one left. Spectators and the demo never come here: their cards are drawn from the document alone.
@MainActor public final class HypertextStore {
    /// The card routes (`live` uses BackendClient). A refusal must come as BackendClient throws it (`ClientError`).
    public struct Transport {
        public var status: @MainActor (_ channel: String, _ ids: [String]) async throws -> Hypertext.Status
        public var save: @MainActor (_ channel: String, _ message: String, _ state: Hypertext.State, _ baseVersion: Int) async throws -> Hypertext.Saved
        public var act: @MainActor (_ channel: String, _ message: String, _ body: JSONValue) async throws -> Hypertext.ActResult
        public var close: @MainActor (_ channel: String, _ message: String) async throws -> Hypertext.Closed
        public init(status: @escaping @MainActor (String, [String]) async throws -> Hypertext.Status,
                    save: @escaping @MainActor (String, String, Hypertext.State, Int) async throws -> Hypertext.Saved,
                    act: @escaping @MainActor (String, String, JSONValue) async throws -> Hypertext.ActResult,
                    close: @escaping @MainActor (String, String) async throws -> Hypertext.Closed) {
            self.status = status; self.save = save; self.act = act; self.close = close
        }
        /// The routes of the signed-in session: `session` answers the client and token in use (nil: signed out, as 401).
        /// `sessionLost` gets a 401 the server gave for the session still in use (the shared session failure contract,
        /// as for every other route): the app signs out. A route tried while signed out, or answered for a session
        /// that has since changed, reports nothing.
        @MainActor public static func live(_ session: @escaping @MainActor () -> (client: BackendClient, token: String)?,
                                           sessionLost: @escaping @MainActor (Error) -> Void = { _ in }) -> Transport {
            @MainActor func call<T: Sendable>(_ work: @MainActor (BackendClient, String) async throws -> T) async throws -> T {
                guard let s = session() else { throw ClientError.http(401) }
                do { return try await work(s.client, s.token) } catch {
                    if ConnectionPolicy.invalidatesSession(error), session()?.token == s.token { sessionLost(error) }
                    throw error
                }
            }
            return Transport(
                status: { ch, ids in try await call { c, t in try await c.hypertextStatus(token: t, channel: ch, ids: ids) } },
                save: { ch, m, state, base in try await call { c, t in try await c.hypertextSave(token: t, channel: ch, message: m, state: state, baseVersion: base) } },
                act: { ch, m, body in try await call { c, t in try await c.hypertextAct(token: t, channel: ch, message: m, body: body) } },
                close: { ch, m in try await call { c, t in try await c.hypertextClose(token: t, channel: ch, message: m) } })
        }
    }
    /// Timings in seconds (tests shorten them).
    public struct Timing: Sendable {
        public var statusDebounce = 0.15, saveDebounce = 0.5, retry = Hypertext.retryPauses, statusRetry = 5.0
        public init() {}
    }
    /// What an interaction needs from the card as it is drawn. The script gets `viewer` only, never a token or an id.
    public struct Context {
        public let messageId: String
        public let channelId: String
        public let doc: Hypertext.Doc
        /// The message's `hypertext` as stored: the engine reads the card itself.
        public let raw: JSONValue
        public let lock: Hypertext.LockReason?
        public let viewer: Hypertext.Viewer
        /// The engine can run here (and has not answered engine_unavailable).
        public let engine: Bool
        /// `Hypertext.sayCharacterToSend`: the composer's character when it is not the viewer's in the card's window.
        public let sayCharacterId: String?
        /// The server's dice are on (`features.dice`); off, a dot command posts as plain text and any line is confirmed.
        public let dice: Bool
        public init(messageId: String, channelId: String, doc: Hypertext.Doc, raw: JSONValue, lock: Hypertext.LockReason?, viewer: Hypertext.Viewer,
                    engine: Bool = true, sayCharacterId: String? = nil, dice: Bool = true) {
            self.messageId = messageId; self.channelId = channelId; self.doc = doc; self.raw = raw; self.lock = lock; self.viewer = viewer
            self.engine = engine; self.sayCharacterId = sayCharacterId; self.dice = dice
        }
    }

    public private(set) var cards: [String: Hypertext.CardEntry] = [:] { didSet { onChange?() } }
    public private(set) var unavailable: Hypertext.Unavailable? = nil { didSet { if oldValue != unavailable { onChange?() } } }
    /// The engine answered engine_unavailable (no WebAssembly here: Lockdown Mode, a jitless WebView): kept for the app
    /// session, through resets. Controls with `on` are disabled from then on.
    public private(set) var engineMissing = false { didSet { if oldValue != engineMissing { onChange?() } } }
    /// Called after every change (the app publishes it to its views).
    public var onChange: (@MainActor () -> Void)?
    /// The lines an action posted, for the chat (de-duplicated there with their pushes by id).
    public var onLines: (@MainActor ([Message]) -> Void)?
    /// Runs one engine request (`Hypertext.engineRequest`) for a card: the result JSON as `MobileHypertext` answers it
    /// (checked again here with `Hypertext.validateOutput`). A host that gives up answers `Hypertext.failureText` (its
    /// timeout: `.timeout`); nil counts as an `engine` failure. Nil while there is no engine host.
    public var engine: (@MainActor (_ card: String, _ request: String) async -> String?)?
    /// The engine is to be dropped (reset: sign-in or out, a channel switch, a new knowledge scope).
    public var disposeEngine: (@MainActor () -> Void)?

    private let transport: Transport
    private let timing: Timing
    private var gen = 0, engineUsed = false
    private var wanted: (channel: String, ids: [String])? = nil
    private var statusTimer: Task<Void, Never>? = nil
    private var saveTimers: [String: Task<Void, Never>] = [:]
    /// The state a PUT of the card is carrying right now, until it is answered.
    private var inflight: [String: Hypertext.State] = [:]
    private var lanes: [String: Task<Void, Never>] = [:]
    private var confirms: [String: @MainActor (Bool) -> Void] = [:]

    public init(transport: Transport, timing: Timing = Timing()) { self.transport = transport; self.timing = timing }

    // Results that come back after a reset are dropped.
    private func token() -> @MainActor () -> Bool { let g = gen; return { [weak self] in self?.gen == g } }
    private func patch(_ id: String, _ change: (inout Hypertext.CardEntry) -> Void) {
        guard var e = cards[id] else { return }
        change(&e)
        if e != cards[id] { cards[id] = e }
    }
    private func pause(_ seconds: Double) async { if seconds > 0 { try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) } }
    // Saves and actions of one card, one after the other.
    @discardableResult private func lane(_ id: String, _ job: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        let previous = lanes[id]
        let run = Task { @MainActor in _ = await previous?.value; await job() }
        lanes[id] = run
        Task { @MainActor [weak self] in _ = await run.value; if self?.lanes[id] == run { self?.lanes[id] = nil } }
        return run
    }
    private func adopt(_ id: String, _ state: Hypertext.State?, _ version: Int, orEqual: Bool = false) { patch(id) { $0.adopt(state, version: version, orEqual: orEqual) } }
    private func setDraft(_ id: String, _ doc: Hypertext.Doc, _ state: Hypertext.State) { patch(id) { $0.setDraft(state, doc: doc, saving: inflight[id] != nil) } }
    private func clearTimer(_ id: String) { saveTimers.removeValue(forKey: id)?.cancel() }
    private func markUnavailable(_ u: Hypertext.Unavailable) { unavailable = unavailable == .missing ? .missing : u }

    private func scheduleSave(_ id: String, now: Bool = false) {
        clearTimer(id)
        let delay = now ? 0 : timing.saveDebounce
        saveTimers[id] = Task { @MainActor [weak self] in
            await self?.pause(delay)
            guard let self, !Task.isCancelled else { return }
            self.saveTimers[id] = nil
            self.lane(id) { [weak self] in await self?.save(id) }
        }
    }
    // The draft, compare-and-swap on the version held. A newer draft made while this one was on its way is saved by its
    // own (later) timer, and again here when none is due: whatever the viewer left on screen is what gets stored.
    private func save(_ id: String) async {
        let alive = token()
        var retries = 0
        while true {
            guard let e = cards[id], let sent = e.draft else { return }
            inflight[id] = sent
            do {
                let r = try await transport.save(e.channelId, id, sent, e.version)
                guard alive() else { return }
                inflight[id] = nil
                adopt(id, r.state, r.version)
                if let after = cards[id], after.draft != nil, !after.pending, saveTimers[id] == nil { scheduleSave(id, now: true) }
                return
            } catch {
                guard alive() else { return }
                let refusal = Hypertext.Refusal(error), o = Hypertext.classify(refusal)
                // Tried again with the draft as it is then; meanwhile the state sent may have reached the server after all.
                if o == .retry && retries < timing.retry.count { await pause(timing.retry[retries]); retries += 1; guard alive() else { return }; continue }
                inflight[id] = nil
                switch o {
                case .missing, .disabled: markUnavailable(o == .missing ? .missing : .disabled); patch(id) { $0.draft = nil }
                case .conflict:
                    let c = Hypertext.conflictState(refusal)
                    adopt(id, c.state, c.version)
                    patch(id) { $0.draft = nil; $0.error = Hypertext.errorSentences["state_conflict"] }
                default:
                    patch(id) { $0.draft = nil; $0.error = o == .retry ? Hypertext.Sentence.unsaved : Hypertext.errorText(refusal) }
                    if o == .refetch || o == .gone { let ch = e.channelId; Task { @MainActor [weak self] in await self?.refetch(ch, [id]) } }
                }
                return
            }
        }
    }

    // The viewer's confirmation of a line; false when they cancel, the card closes or the store is reset.
    private func ask(_ id: String, _ c: Hypertext.Confirm) async -> Bool {
        confirms[id]?(false)
        patch(id) { $0.confirm = c }
        return await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            confirms[id] = { [self] ok in
                confirms[id] = nil
                patch(id) { $0.confirm = nil }
                done.resume(returning: ok)
            }
        }
    }
    // An action that ends without effect: what was shown before it comes back (and is saved, if it was a draft).
    private func revert(_ id: String, _ prev: Hypertext.State?, _ error: String?) {
        patch(id) { $0.revert(to: prev, error: error) }
        if prev != nil { scheduleSave(id) }
    }

    // /act with the same interaction id on every attempt.
    private func send(_ ctx: Context, _ nodeId: String, _ effects: [Hypertext.Effect], _ state: Hypertext.State, _ prev: Hypertext.State?, _ confirmed: Bool) async {
        let id = ctx.messageId, ch = ctx.channelId, alive = token()
        clearTimer(id)   // the action carries the state: a save waiting for its timer is part of it
        await lane(id) { [self] in
            guard alive() else { return }
            var body = Hypertext.actBody(interactionId: Hypertext.newInteractionId(), node: nodeId, effects: effects, state: state,
                                         baseVersion: cards[id]?.version ?? 0, confirmed: confirmed, characterId: ctx.sayCharacterId)
            var asked = confirmed, retries = 0
            while true {
                do {
                    let res = try await transport.act(ch, id, body)
                    guard alive() else { return }
                    if !res.messages.isEmpty { onLines?(res.messages) }
                    patch(id) { $0.finish(res) }
                    return
                } catch {
                    guard alive() else { return }
                    let refusal = Hypertext.Refusal(error), o = Hypertext.classify(refusal)
                    if o == .retry && retries < timing.retry.count { await pause(timing.retry[retries]); retries += 1; guard alive() else { return }; continue }
                    if o == .confirm && !asked, let c = Hypertext.confirmFrom(refusal, body: body) {
                        asked = true
                        let ok = await ask(id, c)
                        guard alive() else { return }
                        if !ok { revert(id, prev, nil); return }
                        body = Hypertext.confirmed(body)
                        continue
                    }
                    switch o {
                    case .missing, .disabled: markUnavailable(o == .missing ? .missing : .disabled); revert(id, prev, nil)
                    case .conflict:
                        let c = Hypertext.conflictState(refusal)
                        adopt(id, c.state, c.version, orEqual: true)
                        patch(id) { $0.pending = false; $0.draft = nil; $0.confirm = nil; $0.error = Hypertext.errorSentences["state_conflict"] }
                    // Closed, used up, taken by someone else…: what was shown before the action comes back (a change made
                    // just before it is saved on its own), and the status is read again.
                    case .refetch, .gone: revert(id, prev, Hypertext.errorText(refusal)); Task { @MainActor [weak self] in await self?.refetch(ch, [id]) }
                    default: revert(id, prev, o == .retry ? Hypertext.Sentence.unsent : Hypertext.errorText(refusal))
                    }
                    return
                }
            }
        }.value
    }

    // MARK: - Status

    private func scheduleStatus(_ seconds: Double? = nil) {
        statusTimer?.cancel()
        let delay = seconds ?? timing.statusDebounce
        statusTimer = Task { @MainActor [weak self] in
            await self?.pause(delay)
            guard let self, !Task.isCancelled else { return }
            self.statusTimer = nil
            self.flushStatus()
        }
    }
    private func flushStatus() {
        guard let wanted else { return }
        let due = wanted.ids.filter { id in cards[id].map { !$0.fetching && (!$0.loaded || $0.stale) } ?? false }
        if !due.isEmpty { Task { @MainActor [weak self] in await self?.refetch(wanted.channel, due) } }
    }

    /// The cards loaded in the open window (`Hypertext.cardIds`): their status is fetched for those not fetched yet
    /// (all of them with `refresh`: a window opened).
    public func track(channel: String, ids: [String], refresh: Bool = false) {
        var unique: [String] = [], seen = Set<String>()
        for id in ids where seen.insert(id).inserted { unique.append(id) }
        wanted = (channel, unique)
        var next = cards
        for id in unique {
            var e = next[id].flatMap { $0.channelId == channel ? $0 : nil } ?? Hypertext.CardEntry(channelId: channel)
            if refresh && e.loaded { e.stale = true }
            next[id] = e
        }
        if next != cards { cards = next }
        if !unique.isEmpty { scheduleStatus() }
    }
    /// The chat stream subscribed again: every tracked card's status is fetched again.
    public func resync() { if let wanted { track(channel: wanted.channel, ids: wanted.ids, refresh: true) } }
    /// Fetches these cards' status now.
    public func refetch(_ channel: String, _ ids: [String]) async {
        let ids = ids.filter { cards[$0] != nil }
        guard !ids.isEmpty else { return }
        let alive = token()
        for id in ids { patch(id) { $0.fetching = true; $0.stale = false } }
        // Known to be unavailable: there is nothing to wait for.
        if unavailable != nil { for id in ids { patch(id) { $0.fetching = false; $0.loaded = true } }; return }
        do {
            let r = try await transport.status(channel, ids)
            guard alive() else { return }
            if !r.enabled { markUnavailable(.disabled); for id in ids { patch(id) { $0.fetching = false; $0.loaded = true } }; return }
            var byId: [String: Hypertext.StatusItem] = [:]
            for x in r.items { byId[x.messageId] = x }
            for id in ids {
                if let x = byId[id] { patch(id) { $0.apply(x) } }
                else { patch(id) { $0.fetching = false; $0.loaded = true; $0.gone = true } }
            }
            // Cards marked stale while this was on its way are asked about again.
            if wanted?.ids.contains(where: { cards[$0]?.stale == true }) == true { scheduleStatus() }
        } catch {
            guard alive() else { return }
            let o = Hypertext.classify(error)
            if o == .missing || o == .gone || o == .disabled {
                markUnavailable(o == .disabled ? .disabled : .missing)
                for id in ids { patch(id) { $0.fetching = false; $0.loaded = true } }
                return
            }
            for id in ids { patch(id) { $0.fetching = false; $0.stale = true } }
            scheduleStatus(timing.statusRetry)   // the controls stay "Loading…" until it arrives
        }
    }

    // MARK: - Pushes

    /// hypertext.state (this viewer's other devices, or the echo of a save): applied when it is newer.
    public func applyState(_ id: String, state: Hypertext.State?, version: Int) { adopt(id, state, version) }
    /// hypertext.closed: the card closes, and a confirmation waiting on it is cancelled.
    public func applyClosed(_ id: String, closedAt: String) {
        guard cards[id] != nil else { return }
        patch(id) { $0.closedAt = closedAt }
        confirms[id]?(false)
    }
    /// The two card pushes. True when the event was one of them: the app returns before its refresh-on-push path, since
    /// they need no refresh. A card not loaded here is ignored.
    @discardableResult public func apply(_ event: RealtimeEvent) -> Bool {
        if let p = event.hypertextState { applyState(p.messageId, state: p.state, version: p.version); return true }
        if let p = event.hypertextClosed { applyClosed(p.messageId, closedAt: p.closedAt); return true }
        return event.type == "hypertext.state" || event.type == "hypertext.closed"
    }

    // MARK: - Acting

    /// A UI action on one control of a card. Returns when the action is over (after any confirmation).
    public func interact(_ ctx: Context, node nodeId: String, action: Hypertext.Action) async {
        let id = ctx.messageId
        guard let e = cards[id], e.loaded, !e.pending, e.confirm == nil, unavailable == nil else { return }
        let doc = ctx.doc, prev = e.draft, shown = Hypertext.shownState(doc, draft: e.draft, state: e.state)
        guard let r = Hypertext.applyAction(doc, shown, nodeId, action, lock: ctx.lock), let node = Hypertext.findNode(doc, nodeId) else { return }
        let handler = node.on
        patch(id) { $0.error = nil; $0.notices = []; if handler != nil { $0.failure = nil; $0.logs = [] } }
        // An input's draft on blur, or a control with nothing to run: the state alone, saved shortly.
        guard let event = r.event, handler != nil || (node.kind == .button && node.act != nil) else { setDraft(id, doc, r.state); scheduleSave(id); return }

        if let handler {
            guard ctx.engine, !engineMissing, let engine else { patch(id) { $0.error = Hypertext.Sentence.noEngine }; return }
            let alive = token()
            patch(id) { $0.pending = true; $0.draft = r.state }   // the control's own change shows while the script runs
            engineUsed = true
            let result: Hypertext.RunResult
            if let request = Hypertext.engineRequest(doc: ctx.raw, state: r.state, prev: shown, handler: handler, event: event, viewer: ctx.viewer) {
                result = Hypertext.validateOutput(doc, prev: shown, raw: await engine(id, request))
            } else { result = Hypertext.failure(.invalidState, "the action is too large to run") }
            guard alive() else { return }
            let run: Hypertext.Run
            switch result {
            case .failed(let error, let logs):
                if error.code == .engineUnavailable { engineMissing = true }
                patch(id) {
                    $0.pending = false; $0.draft = prev; $0.failure = error; $0.logs = logs
                    $0.error = error.code == .engineUnavailable ? Hypertext.Sentence.noEngine : Hypertext.Sentence.failed
                }
                if prev != nil { scheduleSave(id) }
                return
            case .ok(let ok): run = ok
            }
            // Lines this viewer can no longer post (the card's runs are used up): nothing to confirm or send.
            if !run.effects.isEmpty && cards[id]?.runsLeft == 0 { revert(id, prev, Hypertext.errorSentences["runs_exhausted"]); patch(id) { $0.logs = run.logs }; return }
            patch(id) { $0.notices = run.notices; $0.logs = run.logs; $0.failure = nil }
            setDraft(id, doc, run.state)
            if run.effects.isEmpty { patch(id) { $0.pending = false }; if run.changed { scheduleSave(id, now: true) }; return }
            var confirmed = false
            if let confirm = Hypertext.confirmOf(effects: run.effects, confirm: run.confirm, dice: ctx.dice) {
                let ok = await ask(id, confirm)
                guard alive() else { return }
                if !ok { revert(id, prev, nil); patch(id) { $0.notices = [] }; return }
                confirmed = true
            }
            await send(ctx, nodeId, run.effects, run.state, prev, confirmed)
            return
        }

        // A declarative act: set, then say and reply, checked like a script's effects before anything is sent.
        guard let a = Hypertext.act(doc, r.state, nodeId) else { return }
        switch Hypertext.checkEffects(doc, effects: a.effects) {
        case .failure(let f):
            patch(id) { $0.error = Hypertext.Sentence.failed; $0.failure = Hypertext.EngineError(code: .invalidEffect, message: f.message, line: nil) }
        case .success(let effects) where effects.isEmpty:
            setDraft(id, doc, a.state); scheduleSave(id, now: true)
        case .success(let effects):
            patch(id) { $0.pending = true; $0.draft = a.state }
            await send(ctx, nodeId, effects, a.state, prev, false)
        }
    }
    /// The viewer's answer to a confirmation ("Post" or "Cancel").
    public func answer(_ id: String, _ ok: Bool) { confirms[id]?(ok) }
    /// A GM closes a card for everyone. A failure is thrown for the app to show (with the server's message).
    public func close(channel: String, id: String) async throws {
        let alive = token()
        do {
            let r = try await transport.close(channel, id)
            if alive() { patch(id) { $0.closedAt = r.closedAt; $0.closesAt = r.closesAt }; confirms[id]?(false) }
        } catch {
            let o = Hypertext.classify(error)
            if alive() && (o == .missing || o == .disabled) { markUnavailable(o == .missing ? .missing : .disabled) }
            throw error
        }
    }
    /// Sign-in or out, a channel switch, a new knowledge scope: everything goes, late answers are dropped, waiting
    /// confirmations are cancelled and the engine is dropped (started again by the next script, if any).
    public func reset() {
        gen += 1
        for t in saveTimers.values { t.cancel() }
        saveTimers = [:]; lanes = [:]; inflight = [:]
        statusTimer?.cancel(); statusTimer = nil
        wanted = nil
        let waiting = Array(confirms.values); confirms = [:]
        cards = [:]; unavailable = nil
        for r in waiting { r(false) }
        if engineUsed { engineUsed = false; disposeEngine?() }
    }
}
