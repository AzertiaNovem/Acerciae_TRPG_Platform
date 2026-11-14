import XCTest
@testable import AcerciaeCore

/// The action pipeline (HypertextStore), as frontend/tests/hypertext-store.test.cjs checks the web store: one
/// interaction id per action reused by its retries, 428 confirm-and-resend, 409 adopt, partial results, newer pushes
/// only, resets that drop late answers, the feature marked unavailable, coalesced saves. The routes answer only when a
/// test says so.
final class HypertextStoreTests: XCTestCase {
    private typealias H = Hypertext
    private struct Timeout: Error {}

    private static let raw: JSONValue = {
        let text = #"""
        {"v":1,"title":"The study","state":{"seen":{"type":"bool"},"done":{"type":"bool"},"pick":{"type":"enum","values":[{"value":"a"},{"value":"b"}]}},
         "body":[{"type":"checkbox","id":"seen_box","label":"Seen","bind":"seen"},{"type":"choice","id":"pick_box","label":"Pick","bind":"pick","display":"buttons"},
                 {"type":"button","id":"roll","label":"Roll","act":{"set":{"done":true},"say":".ra Spot Hidden"},"enable_if":{"key":"done","eq":false}},
                 {"type":"button","id":"sanity","label":"Sanity","act":{"say":".sc 1/1d6"}},{"type":"button","id":"mark","label":"Mark","act":{"set":{"done":true}}},
                 {"type":"button","id":"go","label":"Go","on":"go"}],
         "script":"on('go', () => { say('I open the door.'); state.done = true; })"}
        """#
        return try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }()
    private static let doc = H.parseDoc(raw)!
    private static let initial: H.State = ["seen": .bool(false), "done": .bool(false), "pick": .null]
    private func state(_ change: [String: JSONValue] = [:]) -> H.State { Self.initial.merging(change) { _, b in b } }
    private func ctx(_ id: String = "m1", lock: H.LockReason? = nil, engine: Bool = true, sayCharacterId: String? = nil, dice: Bool = true) -> HypertextStore.Context {
        .init(messageId: id, channelId: "c", doc: Self.doc, raw: Self.raw, lock: lock, viewer: H.Viewer(gm: false, actor: true, character: "Ada"),
              engine: engine, sayCharacterId: sayCharacterId, dice: dice)
    }
    private func item(_ id: String, state: H.State? = nil, version: Int = 0, runsLeft: Int? = 1, closedAt: String? = nil) -> H.StatusItem {
        H.StatusItem(messageId: id, closesAt: "2099-01-01T00:00:00Z", closedAt: closedAt, closed: closedAt != nil, state: state, version: version, runsLeft: runsLeft)
    }
    private func line(_ id: String) -> Message { var m = Message(id: id, content: ".ra Spot Hidden", authorName: "Ada", characterName: nil, kind: "roll", seq: 1); m.viaHypertextId = "m1"; return m }
    private func refused(_ status: Int, _ code: String, _ details: [String: JSONValue] = [:]) -> Error {
        ClientError.refused(status, .object(["error": .string(code), "message": .string(code)].merging(details) { _, b in b }))
    }
    private let offline = URLError(.notConnectedToInternet)

    @MainActor private func harness() -> (HypertextStore, Routes) {
        let routes = Routes()
        var timing = HypertextStore.Timing()
        timing.statusDebounce = 0; timing.saveDebounce = 0.005; timing.retry = [0.001, 0.002, 0.003]; timing.statusRetry = 0.01
        let store = HypertextStore(transport: routes.transport, timing: timing)
        store.onLines = { routes.lines += $0 }
        store.engine = { card, request in routes.runs.append((card, request)); return routes.engineResult?(request) }
        store.disposeEngine = { routes.disposed += 1 }
        return (store, routes)
    }
    @MainActor private func until(_ label: String, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async throws {
        for _ in 0..<3000 { if condition() { return }; try await Task.sleep(nanoseconds: 1_000_000) }
        XCTFail("timed out waiting for \(label)", file: file, line: line)
        throw Timeout()
    }
    @MainActor private func tick() async { for _ in 0..<20 { await Task.yield() }; try? await Task.sleep(nanoseconds: 20_000_000) }
    @MainActor private func loaded(_ store: HypertextStore, _ routes: Routes, _ id: String = "m1", state: H.State? = nil, version: Int = 0, runsLeft: Int? = 1) async throws {
        store.track(channel: "c", ids: [id])
        try await routes.next("status").resolve(H.Status(enabled: true, items: [item(id, state: state, version: version, runsLeft: runsLeft)]))
        try await until("status") { store.cards[id]?.loaded == true }
    }
    private func runResult(_ json: String) -> (String) -> String? { { _ in json } }

    @MainActor func testStatusIsFetchedOncePerCardAndAgainForAllOnRefreshAndResync() async throws {
        let (store, routes) = harness()
        store.track(channel: "c", ids: ["a", "b", "a"])
        XCTAssertEqual(store.cards["a"]?.loaded, false, "controls wait for the status")
        let first = try await routes.next("status")
        XCTAssertEqual([first.channel] + first.ids, ["c", "a", "b"])
        first.resolve(H.Status(enabled: true, items: [item("a", state: ["seen": .bool(true)], version: 2, runsLeft: 0)]))
        try await until("loaded") { store.cards["a"]?.loaded == true && store.cards["b"]?.loaded == true }
        XCTAssertEqual(store.cards["a"]?.state, ["seen": .bool(true)]); XCTAssertEqual(store.cards["a"]?.version, 2); XCTAssertEqual(store.cards["a"]?.runsLeft, 0)
        XCTAssertEqual(store.cards["b"]?.gone, true, "a card left out of the status (recalled, unreadable) is gone")
        // The set of loaded cards grows: only the new one is asked about.
        store.track(channel: "c", ids: ["a", "b", "c3"])
        let second = try await routes.next("status")
        XCTAssertEqual(second.ids, ["c3"])
        second.resolve(H.Status(enabled: true, items: [item("c3")]))
        try await until("c3") { store.cards["c3"]?.loaded == true }
        store.track(channel: "c", ids: ["a", "b", "c3"])
        await tick()
        XCTAssertEqual(routes.waiting("status"), 0, "nothing new: nothing asked")
        // A window opened again, or the stream subscribed again: all of them.
        store.resync()
        let third = try await routes.next("status")
        XCTAssertEqual(third.ids, ["a", "b", "c3"])
        third.resolve(H.Status(enabled: true, items: [item("a", state: ["seen": .bool(false)], version: 3), item("b"), item("c3", closedAt: "2026-01-01T00:00:00Z")]))
        try await until("refresh adopted") { store.cards["a"]?.version == 3 }
        XCTAssertEqual(store.cards["b"]?.gone, false); XCTAssertEqual(store.cards["c3"]?.closedAt, "2026-01-01T00:00:00Z")
        // A failed status request is tried again later; the controls stay "Loading…" meanwhile.
        store.track(channel: "c", ids: ["d"])
        try await routes.next("status").reject(offline)
        XCTAssertEqual(store.cards["d"]?.loaded, false)
        let retry = try await routes.next("status")
        XCTAssertEqual(retry.ids, ["d"])
        retry.resolve(H.Status(enabled: true, items: [item("d")]))
        try await until("d") { store.cards["d"]?.loaded == true }
    }

    @MainActor func testPlainChangesAreSavedByOneCoalescedPutAndANewerPushWins() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes, state: Self.initial, version: 2)
        await store.interact(ctx(), node: "seen_box", action: .toggle)
        await store.interact(ctx(), node: "pick_box", action: .select("b"))
        await store.interact(ctx(), node: "seen_box", action: .toggle)
        await store.interact(ctx(), node: "seen_box", action: .toggle)
        XCTAssertEqual(store.cards["m1"]?.draft, state(["seen": .bool(true), "pick": .string("b")]), "shown at once")
        let put = try await routes.next("save")
        XCTAssertEqual(put.body, .object(["state": .object(state(["seen": .bool(true), "pick": .string("b")])), "base_version": .number(2)]))
        await tick()
        XCTAssertEqual(routes.waiting("save"), 0, "one request for the four changes")
        put.resolve(H.Saved(state: state(["seen": .bool(true), "pick": .string("b")]), version: 3))
        try await until("saved") { store.cards["m1"]?.version == 3 }
        XCTAssertNil(store.cards["m1"]?.draft, "nothing left to save")
        // Pushes: only a newer version applies.
        let five = state(["done": .bool(true), "pick": .string("a")])
        store.applyState("m1", state: five, version: 5)
        store.applyState("m1", state: state(["seen": .bool(true), "done": .bool(true), "pick": .string("b")]), version: 4)
        store.applyState("m1", state: state(["seen": .bool(true), "done": .bool(true), "pick": .string("b")]), version: 5)
        XCTAssertEqual(store.cards["m1"]?.state, five); XCTAssertEqual(store.cards["m1"]?.version, 5)
        // A save refused because another device saved first adopts the stored state.
        await store.interact(ctx(), node: "seen_box", action: .toggle)
        let conflicting = try await routes.next("save")
        XCTAssertEqual(conflicting.body["base_version"], .number(5))
        conflicting.reject(refused(409, "state_conflict", ["state": .object(state(["pick": .string("b")])), "version": .number(7)]))
        try await until("conflict adopted") { store.cards["m1"]?.version == 7 }
        XCTAssertEqual(store.cards["m1"]?.state, state(["pick": .string("b")])); XCTAssertNil(store.cards["m1"]?.draft)
        XCTAssertEqual(store.cards["m1"]?.error, "This message changed on another device.")
        store.applyClosed("m1", closedAt: "2026-11-14T00:00:00Z")
        XCTAssertEqual(store.cards["m1"]?.closedAt, "2026-11-14T00:00:00Z")
    }

    @MainActor func testANetworkFailureRetriesTheActionWithTheSameInteractionId() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes, runsLeft: 2)
        let done = Task { await store.interact(ctx(), node: "roll", action: .click) }
        let first = try await routes.next("act")
        XCTAssertEqual(store.cards["m1"]?.pending, true)
        XCTAssertEqual(store.cards["m1"]?.draft, state(["done": .bool(true)]), "the new state shows while it is sent")
        var shape = first.body.objectValue ?? [:]; shape["interaction_id"] = .string("x")
        XCTAssertEqual(JSONValue.object(shape), .object(["interaction_id": .string("x"), "node": .string("roll"), "base_version": .number(0), "state": .object(state(["done": .bool(true)])),
                                                          "say": .object(["text": .string(".ra Spot Hidden"), "kind": .string("ic")])]))
        // Ignored meanwhile: one action per card at a time.
        await store.interact(ctx(), node: "seen_box", action: .toggle)
        first.reject(offline)
        let second = try await routes.next("act"); second.reject(ClientError.gateway(502))
        let third = try await routes.next("act"); third.reject(refused(409, "interaction_in_progress"))
        let fourth = try await routes.next("act")
        XCTAssertEqual([second.body, third.body, fourth.body], [first.body, first.body, first.body], "every retry sends the same action")
        fourth.resolve(H.ActResult(interactionId: first.body["interaction_id"].text, replayed: true, messages: [line("r1")], state: H.Saved(state: state(["done": .bool(true)]), version: 1)))
        await done.value
        XCTAssertEqual(routes.lines.map(\.id), ["r1"], "the posted line goes into the chat")
        let c = try XCTUnwrap(store.cards["m1"])
        XCTAssertFalse(c.pending); XCTAssertNil(c.draft); XCTAssertEqual(c.version, 1); XCTAssertEqual(c.state, state(["done": .bool(true)])); XCTAssertEqual(c.runsLeft, 1); XCTAssertNil(c.error)
        XCTAssertEqual(routes.waiting("save"), 0)
    }

    @MainActor func testAfterThreeRetriesTheActionRevertsAndARefusalRevertsWithItsReason() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes)
        let done = Task { await store.interact(ctx(), node: "roll", action: .click) }
        var ids = Set<String>()
        for _ in 0..<4 { let r = try await routes.next("act"); ids.insert(r.body["interaction_id"].text); r.reject(offline) }
        await done.value
        XCTAssertEqual(ids.count, 1)
        XCTAssertEqual(store.cards["m1"]?.pending, false); XCTAssertNil(store.cards["m1"]?.draft)
        XCTAssertEqual(store.cards["m1"]?.error, "This message's action could not be sent. Check your connection.")
        XCTAssertEqual(routes.waiting("act"), 0, "no fifth attempt")
        // Refused (403, not an actor): reverted, the reason in the catalog's words; a new click is a new interaction.
        let again = Task { await store.interact(ctx(), node: "roll", action: .click) }
        let r = try await routes.next("act")
        XCTAssertFalse(ids.contains(r.body["interaction_id"].text), "a new action has a new id")
        r.reject(refused(403, "not_an_actor"))
        await again.value
        XCTAssertNil(store.cards["m1"]?.draft); XCTAssertEqual(store.cards["m1"]?.error, "This message is for other characters.")
    }

    @MainActor func testA428IsConfirmedAndTheSameActionIsSentAgainAndCancellingSendsNothing() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes)
        let done = Task { await store.interact(ctx(), node: "sanity", action: .click) }
        let first = try await routes.next("act")
        XCTAssertNil(first.body["say"].objectValue?["confirmed"])
        first.reject(refused(428, "confirmation_required", ["text": .string(".sc 1/1d6")]))
        try await until("confirm") { store.cards["m1"]?.confirm != nil }
        XCTAssertEqual(store.cards["m1"]?.confirm, H.Confirm(text: ".sc 1/1d6", kind: .ic, sheet: true))
        store.answer("m1", true)
        let second = try await routes.next("act")
        XCTAssertEqual(second.body["interaction_id"], first.body["interaction_id"])
        XCTAssertEqual(second.body["say"], .object(["text": .string(".sc 1/1d6"), "kind": .string("ic"), "confirmed": .bool(true)]))
        second.resolve(H.ActResult(messages: [line("s1")], state: H.Saved(state: Self.initial, version: 1)))
        await done.value
        XCTAssertNil(store.cards["m1"]?.confirm)
        // Cancel: reverted, nothing more is sent.
        let cancelled = Task { await store.interact(ctx(), node: "sanity", action: .click) }
        try await routes.next("act").reject(refused(428, "confirmation_required", ["text": .string(".sc 1/1d6")]))
        try await until("confirm 2") { store.cards["m1"]?.confirm != nil }
        store.answer("m1", false)
        await cancelled.value
        await tick()
        XCTAssertEqual(routes.waiting("act"), 0)
        XCTAssertEqual(store.cards["m1"]?.pending, false); XCTAssertNil(store.cards["m1"]?.confirm); XCTAssertNil(store.cards["m1"]?.draft)
    }

    @MainActor func testA409AdoptsTheStateFromTheRefusalOrFetchesTheStatusAgain() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes)
        var done = Task { await store.interact(ctx(), node: "roll", action: .click) }
        try await routes.next("act").reject(refused(409, "state_conflict", ["state": .object(state(["seen": .bool(true), "done": .bool(true), "pick": .string("a")])), "version": .number(4)]))
        await done.value
        XCTAssertEqual(store.cards["m1"]?.state, state(["seen": .bool(true), "done": .bool(true), "pick": .string("a")])); XCTAssertEqual(store.cards["m1"]?.version, 4)
        XCTAssertNil(store.cards["m1"]?.draft); XCTAssertEqual(store.cards["m1"]?.pending, false)
        // Another 409 (closed, used up): the status again, and it is adopted.
        done = Task { await store.interact(ctx(), node: "sanity", action: .click) }
        let act = try await routes.next("act")
        XCTAssertEqual(act.body["base_version"], .number(4), "from the version adopted")
        act.reject(refused(409, "runs_exhausted"))
        await done.value
        XCTAssertEqual(store.cards["m1"]?.error, "You already used this.")
        let st = try await routes.next("status")
        XCTAssertEqual(st.ids, ["m1"])
        st.resolve(H.Status(enabled: true, items: [item("m1", state: state(["seen": .bool(true), "done": .bool(true), "pick": .string("b")]), version: 5, runsLeft: 0)]))
        try await until("refetched") { store.cards["m1"]?.version == 5 }
        XCTAssertEqual(store.cards["m1"]?.runsLeft, 0)
    }

    @MainActor func testPartialResultsMergeThePostedLinesAndSaySoAndAnUnreadableLineIsNotMerged() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes)
        let done = Task { await store.interact(ctx(), node: "roll", action: .click) }
        try await routes.next("act").resolve(H.ActResult(interactionId: "i", partial: true, messages: [line("p1")], state: H.Saved(state: state(["done": .bool(true)]), version: 1)))
        await done.value
        XCTAssertEqual(routes.lines.map(\.id), ["p1"])
        XCTAssertEqual(store.cards["m1"]?.version, 1); XCTAssertEqual(store.cards["m1"]?.error, "Part of this action could not be posted."); XCTAssertEqual(store.cards["m1"]?.pending, false)
        let again = Task { await store.interact(ctx(), node: "sanity", action: .click) }
        try await routes.next("act").resolve(H.ActResult(interactionId: "j"))
        await again.value
        XCTAssertEqual(routes.lines.count, 1)
    }

    @MainActor func testAScriptHandlerShowsItsStateAndNoticesAndItsFreeTextWaitsForTheViewer() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes)
        routes.engineResult = runResult(#"{"ok":true,"state":{"seen":false,"done":true,"pick":null},"effects":[{"type":"say","text":"I open the door.","kind":"ic"}],"notices":["Creak."],"logs":["ran"],"confirm":null,"changed":true}"#)
        let done = Task { await store.interact(ctx(), node: "go", action: .click) }
        try await until("confirm") { store.cards["m1"]?.confirm != nil }
        let run = try XCTUnwrap(routes.runs.first)
        let request = try JSONDecoder().decode(JSONValue.self, from: Data(run.1.utf8))
        XCTAssertEqual(run.0, "m1")
        XCTAssertEqual(request["handler"], .string("go")); XCTAssertEqual(request["event"], .object(["type": .string("click"), "node": .string("go"), "value": .null]))
        XCTAssertEqual(request["viewer"], .object(["gm": .bool(false), "actor": .bool(true), "character": .string("Ada")]))
        XCTAssertEqual(request["doc"], Self.raw); XCTAssertEqual(request["prev"].objectValue, Self.initial)
        XCTAssertEqual(Set(request.object.keys), ["doc", "event", "handler", "prev", "state", "viewer"], "the engine gets the card and the viewer, nothing else")
        XCTAssertEqual(store.cards["m1"]?.confirm, H.Confirm(text: "I open the door.", kind: .ic), "recomputed natively: free text is confirmed")
        XCTAssertEqual(store.cards["m1"]?.notices, ["Creak."]); XCTAssertEqual(store.cards["m1"]?.logs, ["ran"]); XCTAssertEqual(store.cards["m1"]?.draft, state(["done": .bool(true)]))
        XCTAssertEqual(routes.waiting("act"), 0, "nothing is sent before the viewer confirms")
        store.answer("m1", true)
        let act = try await routes.next("act")
        XCTAssertEqual(act.body["say"], .object(["text": .string("I open the door."), "kind": .string("ic"), "confirmed": .bool(true)]))
        act.resolve(H.ActResult(messages: [line("d1")], state: H.Saved(state: state(["done": .bool(true)]), version: 1)))
        await done.value
        // A failing script: reverted, nothing sent, the details kept for GMs.
        routes.engineResult = runResult(#"{"ok":false,"error":{"code":"script_error","message":"boom","line":1},"logs":["before"]}"#)
        await store.interact(ctx(), node: "go", action: .click)
        var c = try XCTUnwrap(store.cards["m1"])
        XCTAssertEqual(c.error, "This message's action failed."); XCTAssertEqual(c.failure, H.EngineError(code: .scriptError, message: "boom", line: 1))
        XCTAssertEqual(c.logs, ["before"]); XCTAssertNil(c.draft); XCTAssertFalse(c.pending)
        XCTAssertEqual(routes.waiting("act"), 0)
        // A forged result the bundle should never send is refused here too.
        routes.engineResult = runResult(#"{"ok":true,"state":{"seen":false,"done":true,"pick":null},"effects":[{"type":"say","text":".st STR 99","kind":"ic"}]}"#)
        await store.interact(ctx(), node: "go", action: .click)
        XCTAssertEqual(store.cards["m1"]?.failure?.code, .invalidEffect); XCTAssertEqual(routes.waiting("act"), 0)
        // No effects: the changed state is saved by a PUT.
        routes.engineResult = runResult(#"{"ok":true,"state":{"seen":false,"done":true,"pick":"a"},"effects":[],"notices":[],"logs":[],"confirm":null,"changed":true}"#)
        await store.interact(ctx(), node: "go", action: .click)
        let put = try await routes.next("save")
        XCTAssertEqual(put.body["state"].objectValue, state(["done": .bool(true), "pick": .string("a")]))
        put.resolve(H.Saved(state: state(["done": .bool(true), "pick": .string("a")]), version: 2))
        try await until("saved") { store.cards["m1"]?.version == 2 }
        // Without the engine on this device, a handler does not run.
        let before = routes.runs.count
        await store.interact(ctx(engine: false), node: "go", action: .click)
        XCTAssertEqual(routes.runs.count, before)
        XCTAssertEqual(store.cards["m1"]?.error, "Interactive actions are unavailable on this device.")
        // The first engine_unavailable answer is kept for the app session, through resets.
        routes.engineResult = runResult(#"{"ok":false,"error":{"code":"engine_unavailable","message":"WebAssembly is not available on this device"}}"#)
        await store.interact(ctx(), node: "go", action: .click)
        c = try XCTUnwrap(store.cards["m1"])
        XCTAssertTrue(store.engineMissing); XCTAssertEqual(c.error, "Interactive actions are unavailable on this device.")
        let tried = routes.runs.count
        await store.interact(ctx(), node: "go", action: .click)
        XCTAssertEqual(routes.runs.count, tried)
        store.reset(); XCTAssertTrue(store.engineMissing)
        // Declarative acts keep working without the engine.
        try await loaded(store, routes)
        let roll = Task { await store.interact(ctx(), node: "roll", action: .click) }
        try await routes.next("act").resolve(H.ActResult(state: H.Saved(state: state(["done": .bool(true)]), version: 1)))
        await roll.value
        XCTAssertEqual(store.cards["m1"]?.version, 1)
    }

    @MainActor func testAResetDropsLateAnswersCancelsConfirmationsAndStopsTheEngine() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes)
        let act = Task { await store.interact(ctx(), node: "roll", action: .click) }
        let sent = try await routes.next("act")
        store.track(channel: "c", ids: ["m1", "m2"])
        let late = try await routes.next("status")
        routes.engineResult = runResult(#"{"ok":true,"state":{"seen":false,"done":false,"pick":null},"effects":[{"type":"say","text":"Hi","kind":"ic"}],"notices":[],"logs":[],"confirm":null,"changed":false}"#)
        store.track(channel: "c", ids: ["m3"])
        try await routes.next("status").resolve(H.Status(enabled: true, items: [item("m3")]))
        try await until("m3") { store.cards["m3"]?.loaded == true }
        let asking = Task { await store.interact(ctx("m3"), node: "go", action: .click) }
        try await until("confirm") { store.cards["m3"]?.confirm != nil }
        store.reset()
        XCTAssertTrue(store.cards.isEmpty)
        XCTAssertEqual(routes.disposed, 1, "the engine goes with the session")
        await asking.value
        sent.resolve(H.ActResult(messages: [line("late")], state: H.Saved(state: Self.initial, version: 1)))
        late.resolve(H.Status(enabled: true, items: [item("m1"), item("m2")]))
        await act.value; await tick()
        XCTAssertTrue(store.cards.isEmpty, "nothing from before the reset comes back")
        XCTAssertTrue(routes.lines.isEmpty)
        XCTAssertEqual(routes.waiting("act"), 0)
        // Pushes for cards not tracked are ignored.
        store.applyState("m1", state: ["seen": .bool(true)], version: 9)
        XCTAssertNil(store.cards["m1"])
    }

    @MainActor func testTheFeatureIsUnavailableOnAnOlderOrSwitchedOffServerAndTheApisOwn404IsACardGone() async throws {
        var (store, routes) = harness()
        store.track(channel: "c", ids: ["m1"])
        try await routes.next("status").reject(ClientError.gateway(404))
        try await until("loaded") { store.cards["m1"]?.loaded == true }
        XCTAssertEqual(store.unavailable, .missing)
        await store.interact(ctx(), node: "roll", action: .click)
        XCTAssertEqual(routes.waiting("act"), 0, "nothing is sent while unavailable")

        (store, routes) = harness()
        store.track(channel: "c", ids: ["m1"])
        try await routes.next("status").resolve(H.Status(enabled: false, items: []))
        try await until("loaded") { store.cards["m1"]?.loaded == true }
        XCTAssertEqual(store.unavailable, .disabled)

        (store, routes) = harness()
        try await loaded(store, routes)
        var done = Task { await store.interact(ctx(), node: "roll", action: .click) }
        try await routes.next("act").reject(refused(403, "feature_disabled"))
        await done.value
        XCTAssertEqual(store.unavailable, .disabled); XCTAssertNil(store.cards["m1"]?.draft); XCTAssertEqual(store.cards["m1"]?.pending, false)

        (store, routes) = harness()
        try await loaded(store, routes)
        await store.interact(ctx(), node: "seen_box", action: .toggle)
        try await routes.next("save").reject(ClientError.gateway(405))
        try await until("missing") { store.unavailable == .missing }
        XCTAssertNil(store.cards["m1"]?.draft)

        // The API's own 404 (the card was recalled meanwhile): reverted, and its status asked again.
        (store, routes) = harness()
        try await loaded(store, routes)
        done = Task { await store.interact(ctx(), node: "roll", action: .click) }
        try await routes.next("act").reject(refused(404, "not_found"))
        await done.value
        XCTAssertNil(store.unavailable)
        try await routes.next("status").resolve(H.Status(enabled: true, items: []))
        try await until("gone") { store.cards["m1"]?.gone == true }
    }

    @MainActor func testADeclarativeActThatPostsNothingIsAPutAndClosingAdoptsTheClosingTime() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes)
        await store.interact(ctx(), node: "mark", action: .click)
        let put = try await routes.next("save")
        XCTAssertEqual(put.body, .object(["state": .object(state(["done": .bool(true)])), "base_version": .number(0)]))
        XCTAssertEqual(routes.waiting("act"), 0)
        put.resolve(H.Saved(state: state(["done": .bool(true)]), version: 1))
        try await until("saved") { store.cards["m1"]?.version == 1 }
        // A control the lock disables does nothing.
        await store.interact(ctx(lock: .closed), node: "seen_box", action: .toggle)
        await tick()
        XCTAssertNil(store.cards["m1"]?.draft)
        let closing = Task { try await store.close(channel: "c", id: "m1") }
        try await routes.next("close").resolve(H.Closed(closesAt: "2099-01-01T00:00:00Z", closedAt: "2026-11-14T10:00:00Z"))
        try await closing.value
        XCTAssertEqual(store.cards["m1"]?.closedAt, "2026-11-14T10:00:00Z")
        // A refused close is thrown for the app to show; an older server marks the feature missing.
        let refusedClose = Task { try await store.close(channel: "c", id: "m1") }
        try await routes.next("close").reject(ClientError.gateway(404))
        do { try await refusedClose.value; XCTFail("expected a failure") } catch { XCTAssertEqual(store.unavailable, .missing) }
    }

    @MainActor func testAChangeBackToTheSavedValueWhileASaveIsOnItsWayIsSavedToo() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes, state: Self.initial, version: 2)
        await store.interact(ctx(), node: "seen_box", action: .toggle)
        let first = try await routes.next("save")
        XCTAssertEqual(first.body, .object(["state": .object(state(["seen": .bool(true)])), "base_version": .number(2)]))
        // Unticked again before the PUT answered: that equals the server's last copy, yet must still be stored.
        await store.interact(ctx(), node: "seen_box", action: .toggle)
        XCTAssertEqual(store.cards["m1"]?.draft, Self.initial, "the untick shows and is kept to be saved")
        first.resolve(H.Saved(state: state(["seen": .bool(true)]), version: 3))
        let second = try await routes.next("save")
        XCTAssertEqual(second.body, .object(["state": .object(Self.initial), "base_version": .number(3)]))
        second.resolve(H.Saved(state: Self.initial, version: 4))
        try await until("saved again") { store.cards["m1"]?.version == 4 }
        XCTAssertNil(store.cards["m1"]?.draft); XCTAssertEqual(store.cards["m1"]?.state?["seen"], .bool(false))
        await tick()
        XCTAssertEqual(routes.waiting("save"), 0, "nothing more to save")
        // Without a save on its way, a change back to the server's copy needs no request.
        await store.interact(ctx(), node: "seen_box", action: .toggle)
        await store.interact(ctx(), node: "seen_box", action: .toggle)
        XCTAssertNil(store.cards["m1"]?.draft)
        await tick()
        XCTAssertEqual(routes.waiting("save"), 0)
    }

    @MainActor func testAnActionRefusedAsUsedUpKeepsTheChangeMadeJustBeforeItAndSavesIt() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes)
        await store.interact(ctx(), node: "seen_box", action: .toggle)                    // its save is still waiting for its timer…
        let done = Task { await store.interact(ctx(), node: "sanity", action: .click) }  // …and goes with the action
        let act = try await routes.next("act")
        XCTAssertEqual(act.body["state"]["seen"], .bool(true))
        act.reject(refused(409, "reply_exhausted"))
        await done.value
        XCTAssertEqual(store.cards["m1"]?.draft, state(["seen": .bool(true)])); XCTAssertEqual(store.cards["m1"]?.error, "This answer is no longer available.")
        let put = try await routes.next("save"), st = try await routes.next("status")
        XCTAssertEqual(put.body["state"].objectValue, state(["seen": .bool(true)]))
        XCTAssertEqual(st.ids, ["m1"])
    }

    @MainActor func testAScriptWhoseLinesCanNoLongerBePostedAsksNothingAndSendsNothing() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes, runsLeft: 0)
        routes.engineResult = runResult(#"{"ok":true,"state":{"seen":false,"done":true,"pick":null},"effects":[{"type":"say","text":"brb, need a sec","kind":"ooc"}],"notices":["Hm."],"logs":["ran"],"confirm":null,"changed":true}"#)
        await store.interact(ctx(), node: "go", action: .click)
        let c = try XCTUnwrap(store.cards["m1"])
        XCTAssertNil(c.confirm); XCTAssertFalse(c.pending); XCTAssertNil(c.draft); XCTAssertEqual(c.error, "You already used this."); XCTAssertEqual(c.notices, []); XCTAssertEqual(c.logs, ["ran"])
        await tick()
        XCTAssertEqual(routes.waiting("act") + routes.waiting("save"), 0)
        // A handler that only changes the state still works.
        routes.engineResult = runResult(#"{"ok":true,"state":{"seen":false,"done":false,"pick":"a"},"effects":[],"notices":[],"logs":[],"confirm":null,"changed":true}"#)
        await store.interact(ctx(), node: "go", action: .click)
        let put = try await routes.next("save")
        XCTAssertEqual(put.body["state"].objectValue, state(["pick": .string("a")]))
    }

    @MainActor func testTheLineGoesOutAsTheComposersCharacterAndWithDiceOffEveryScriptLineIsConfirmed() async throws {
        let (store, routes) = harness()
        try await loaded(store, routes, runsLeft: 5)
        var done = Task { await store.interact(ctx(sayCharacterId: "bea"), node: "roll", action: .click) }
        var act = try await routes.next("act")
        XCTAssertEqual(act.body["say"], .object(["text": .string(".ra Spot Hidden"), "kind": .string("ic"), "character_id": .string("bea")]))
        act.resolve(H.ActResult(state: H.Saved(state: state(["done": .bool(true)]), version: 1)))
        await done.value
        XCTAssertEqual(store.cards["m1"]?.version, 1)
        // Dice off: a roll from a script is plain text, so the viewer confirms it (no sheet warning).
        routes.engineResult = runResult(#"{"ok":true,"state":{"seen":false,"done":true,"pick":null},"effects":[{"type":"say","text":".ra Spot Hidden","kind":"ic"}],"notices":[],"logs":[],"confirm":null,"changed":false}"#)
        done = Task { await store.interact(ctx(dice: false), node: "go", action: .click) }
        try await until("confirm") { store.cards["m1"]?.confirm != nil }
        XCTAssertEqual(store.cards["m1"]?.confirm, H.Confirm(text: ".ra Spot Hidden", kind: .ic))
        store.answer("m1", true)
        act = try await routes.next("act")
        XCTAssertEqual(act.body["say"], .object(["text": .string(".ra Spot Hidden"), "kind": .string("ic"), "confirmed": .bool(true)]))
        act.resolve(H.ActResult())
        await done.value
        // The server asks for it: its 428 says whether the sheet changes.
        done = Task { await store.interact(ctx(), node: "sanity", action: .click) }
        try await routes.next("act").reject(refused(428, "confirmation_required", ["text": .string(".sc 1/1d6"), "sheet": .bool(false)]))
        try await until("confirm 2") { store.cards["m1"]?.confirm != nil }
        XCTAssertEqual(store.cards["m1"]?.confirm, H.Confirm(text: ".sc 1/1d6", kind: .ic))
        store.answer("m1", false)
        await done.value
    }

    @MainActor func testTheTwoPushesApplyAndReturnBeforeTheRefreshPath() async throws {
        let frames = try { () throws -> [JSONValue] in
            var directory = URL(fileURLWithPath: #filePath)
            for _ in 0..<5 { directory.deleteLastPathComponent() }
            return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: directory.appendingPathComponent("contracts/fixtures/realtime-events.json")))["events"].array
        }()
        let (store, routes) = harness()
        let card = frames[5]["message_id"].text
        let state = try XCTUnwrap(RealtimeEvent.parse(H.jsonText(frames[5]))), closed = try XCTUnwrap(RealtimeEvent.parse(H.jsonText(frames[6])))
        XCTAssertTrue(store.apply(state), "handled even for a card not loaded here")
        XCTAssertNil(store.cards[card])
        try await loaded(store, routes, card)
        XCTAssertTrue(store.apply(state))
        XCTAssertEqual(store.cards[card]?.state, ["door": .null, "lamp": .bool(true)]); XCTAssertEqual(store.cards[card]?.version, 1)
        store.applyState(card, state: ["lamp": .bool(false)], version: 1)
        XCTAssertEqual(store.cards[card]?.state?["lamp"], .bool(true), "the echo of an equal version is ignored")
        XCTAssertTrue(store.apply(closed))
        XCTAssertEqual(store.cards[card]?.closedAt, "2026-11-14T14:25:47.149433+00:00")
        XCTAssertFalse(store.apply(try XCTUnwrap(RealtimeEvent.parse(H.jsonText(frames[2])))), "any other push takes the usual path")
    }
}

/// The card routes of a test: each call waits until the test answers it.
@MainActor private final class Routes {
    struct Call {
        let kind: String, channel: String, message: String, ids: [String], body: JSONValue
        let answer: (Result<Any, Error>) -> Void
        func resolve(_ value: Any) { answer(.success(value)) }
        func reject(_ error: Error) { answer(.failure(error)) }
    }
    private(set) var calls: [Call] = []
    var lines: [Message] = []
    var runs: [(String, String)] = []
    var engineResult: ((String) -> String?)? = nil
    var disposed = 0
    var transport: HypertextStore.Transport {
        HypertextStore.Transport(
            status: { [unowned self] ch, ids in try await self.wait("status", ch, "", ids, .null) },
            save: { [unowned self] ch, m, state, base in try await self.wait("save", ch, m, [], .object(["state": .object(state), "base_version": .number(Double(base))])) },
            act: { [unowned self] ch, m, body in try await self.wait("act", ch, m, [], body) },
            close: { [unowned self] ch, m in try await self.wait("close", ch, m, [], .null) })
    }
    private func wait<T>(_ kind: String, _ channel: String, _ message: String, _ ids: [String], _ body: JSONValue) async throws -> T {
        let value: Any = try await withCheckedThrowingContinuation { (c: CheckedContinuation<Any, Error>) in
            calls.append(Call(kind: kind, channel: channel, message: message, ids: ids, body: body, answer: { c.resume(with: $0) }))
        }
        return value as! T
    }
    func waiting(_ kind: String) -> Int { calls.filter { $0.kind == kind }.count }
    func next(_ kind: String, file: StaticString = #filePath, line: UInt = #line) async throws -> Call {
        for _ in 0..<3000 {
            if let i = calls.firstIndex(where: { $0.kind == kind }) { return calls.remove(at: i) }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("no \(kind) request came", file: file, line: line)
        throw URLError(.timedOut)
    }
}
