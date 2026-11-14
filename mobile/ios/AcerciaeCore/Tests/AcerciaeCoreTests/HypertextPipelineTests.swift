import XCTest
@testable import AcerciaeCore

/// Interactive messages around the card logic: message rows, the card routes of BackendClient, the two pushes, the
/// pipeline's decisions (HypertextPipeline.swift) and how a card is drawn (HypertextCard.tsx's lock reasons and footer).
final class HypertextPipelineTests: XCTestCase {
    private typealias H = Hypertext

    private func contracts(_ path: String) throws -> Data {
        var directory = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { directory.deleteLastPathComponent() }
        return try Data(contentsOf: directory.appendingPathComponent("contracts/" + path))
    }
    private func j(_ text: String) -> JSONValue { (try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .string("<bad test JSON>") }
    private func study() throws -> (JSONValue, H.Doc) {
        let raw = try JSONDecoder().decode(JSONValue.self, from: contracts("fixtures/hypertext-client.json"))["docs"]["study"]
        return (raw, try XCTUnwrap(H.parseDoc(raw)))
    }

    // MARK: - Message rows

    func testCardRowsDecodeTheirDocumentWithTheServersKeysAndSurviveTheHistorySnapshot() throws {
        let (raw, doc) = try study()
        let row: JSONValue = .object(["id": .string("card"), "content": .string("The study"), "author_name": .string("GM"), "author_id": .string("gm"), "kind": .string("hypertext"),
                                      "seq": .number(4), "chat_window_id": .string("w1"), "hypertext": raw, "via_hypertext_id": .null, "via_user_id": .null])
        let m = try APIJSON.decoder().decode(Message.self, from: Data(H.jsonText(row).utf8))
        XCTAssertEqual(m.chatWindowId, "w1"); XCTAssertTrue(m.isHypertext); XCTAssertNil(m.viaHypertextId)
        // The snake-case strategy leaves the card's own keys (show_if, enable_if, say_kind, submit_label) as written.
        XCTAssertEqual(H.parseDoc(m.hypertext), doc)
        XCTAssertEqual(m.hypertext, raw)
        // The history snapshot is re-encoded from decoded rows: the card survives it unchanged.
        let stored = try JSONEncoder().encode(ChatHistory(messages: [m], hasOlder: false))
        let back = try APIJSON.decoder().decode(ChatHistory.self, from: stored)
        XCTAssertEqual(back.messages, [m]); XCTAssertEqual(H.parseDoc(back.messages[0].hypertext), doc)
        // Rows (and snapshots) without the new fields still decode.
        let older = try APIJSON.decoder().decode(Message.self, from: Data(#"{"id":"old","content":"Hi","author_name":"Ann","kind":"ic","seq":1}"#.utf8))
        XCTAssertNil(older.chatWindowId); XCTAssertNil(older.hypertext); XCTAssertNil(older.viaUserName); XCTAssertFalse(older.isHypertext)
        // A recalled card: its tombstone has no document.
        let tomb = try APIJSON.decoder().decode(Message.self, from: Data(#"{"id":"card","content":"","author_name":"GM","kind":"hypertext","seq":4,"hypertext":null,"recalled_at":"2026-11-14T00:00:00Z"}"#.utf8))
        XCTAssertNil(tomb.hypertext); XCTAssertNil(H.parseDoc(tomb.hypertext))
        XCTAssertEqual(H.cardIds([m, older, tomb]), ["card"], "a recalled card's status is not asked for")
        // The server's own frame carries the window.
        let frames = try JSONDecoder().decode(JSONValue.self, from: contracts("fixtures/realtime-events.json"))["events"].array
        XCTAssertEqual(RealtimeEvent.parse(H.jsonText(frames[2]))?.message?.chatWindowId, frames[2]["message"]["chat_window_id"].string)
    }
    func testLinesPostedByACardSayWhoActedAndCardsAreNotReadAloud() throws {
        func line(_ json: String) throws -> Message { try APIJSON.decoder().decode(Message.self, from: Data(json.utf8)) }
        let reply = try line(#"{"id":"r","content":"The door opens.","author_name":"GM","author_id":"gm","kind":"narration","seq":5,"via_hypertext_id":"card","via_user_id":"u2","via_user_name":"Bea"}"#)
        XCTAssertEqual(reply.viaHypertextId, "card"); XCTAssertEqual(reply.answering, "Bea")
        let roll = try line(#"{"id":"s","content":".ra Spot Hidden","author_name":"Bea","author_id":"u2","kind":"roll","seq":6,"via_hypertext_id":"card","via_user_id":"u2","via_user_name":"Bea"}"#)
        XCTAssertNil(roll.answering, "a line the actor posted themselves answers nobody")
        XCTAssertTrue(roll.speakable)
        var card = Message(id: "c", content: "The study", authorName: "GM", characterName: nil, kind: "hypertext", seq: 1)
        XCTAssertFalse(card.speakable, "a card's text is its fallback, not something said at the table")
        card = Message(id: "s", content: "joined", authorName: "", characterName: nil, kind: "system", seq: 2)
        XCTAssertFalse(card.speakable)
    }

    // MARK: - The card routes

    private func client(_ reply: @escaping @Sendable (URLRequest, Data) -> (Int, String)) throws -> BackendClient {
        CardProbe.reset(reply)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CardProbe.self]
        return BackendClient(address: try BackendAddress("https://cards.test"), session: URLSession(configuration: config))
    }
    private func ids(_ r: URLRequest) -> [String] {
        URLComponents(url: r.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "ids" }?.value?.split(separator: ",").map(String.init) ?? []
    }
    func testStatusAsksAtMostAHundredCardsARequestAndJoinsThem() async throws {
        let c = try client { r, _ in
            let asked = URLComponents(url: r.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "ids" }?.value?.split(separator: ",") ?? []
            let items = asked.map { #"{"message_id":"\#($0)","closes_at":"2099-01-01T00:00:00Z","closed_at":null,"closed":false,"state":{"seen":true},"version":2,"runs_left":1}"# }
            return (200, #"{"enabled":true,"items":[\#(items.joined(separator: ","))]}"#)
        }
        let all = (0..<230).map { "id\($0)" }
        let r = try await c.hypertextStatus(token: "test-only", channel: "c", ids: all)
        let requests = CardProbe.requests
        XCTAssertEqual(requests.map { ids($0.request).count }, [100, 100, 30])
        XCTAssertEqual(requests.flatMap { ids($0.request) }, all)
        XCTAssertTrue(requests.allSatisfy { $0.request.url?.path == "/api/channels/c/hypertext" && ($0.request.httpMethod ?? "GET") == "GET" })
        XCTAssertEqual(requests.first?.request.value(forHTTPHeaderField: "Authorization"), "Bearer test-only")
        XCTAssertEqual(r.items.map(\.messageId), all)
        XCTAssertEqual(r.items[0], H.StatusItem(messageId: "id0", closesAt: "2099-01-01T00:00:00Z", closedAt: nil, closed: false, state: ["seen": .bool(true)], version: 2, runsLeft: 1))
        // Turned off: the answer says so at once.
        let off = try client { _, _ in (200, #"{"enabled":false,"items":[]}"#) }
        let disabled = try await off.hypertextStatus(token: "test-only", channel: "c", ids: all)
        XCTAssertEqual(disabled, H.Status(enabled: false, items: []))
        XCTAssertEqual(CardProbe.requests.count, 1)
        // No cards: nothing to ask.
        let none = try await off.hypertextStatus(token: "test-only", channel: "c", ids: [])
        XCTAssertEqual(none, H.Status(enabled: true, items: []))
    }
    @MainActor func testTheLiveRoutesReportALostSessionForTheSessionInUseOnly() async throws {
        let c = try client { r, _ in
            r.url?.lastPathComponent == "act" ? (401, #"{"error":"unauthorized","message":"sign in"}"#) : (409, #"{"error":"state_conflict","message":"changed","state":{},"version":2}"#)
        }
        var current: (client: BackendClient, token: String)? = (client: c, token: "first")
        var lost: [Int?] = []
        let live = HypertextStore.Transport.live({ current }, sessionLost: { lost.append(($0 as? ClientError)?.httpStatus) })
        let body = H.actBody(interactionId: "i1", node: "go", effects: [], state: [:], baseVersion: 0)
        // A 401 for the session in use: the app signs out, and the store still gets the error.
        do { _ = try await live.act("c", "m1", body); XCTFail("expected 401") } catch { XCTAssertEqual((error as? ClientError)?.httpStatus, 401) }
        XCTAssertEqual(lost, [401])
        // Any other refusal is the card's business only.
        do { _ = try await live.save("c", "m1", [:], 1); XCTFail("expected 409") } catch {}
        XCTAssertEqual(lost, [401])
        // Signed out already: nothing is sent and nothing is reported.
        current = nil
        let sent = CardProbe.requests.count
        do { _ = try await live.act("c", "m1", body); XCTFail("expected 401") } catch { XCTAssertTrue(ConnectionPolicy.invalidatesSession(error)) }
        XCTAssertEqual(CardProbe.requests.count, sent); XCTAssertEqual(lost, [401])
        // An answer for a session that has changed meanwhile signs nobody out.
        current = (client: c, token: "second")
        let switching = HypertextStore.Transport.live({ defer { current = (client: c, token: "third") }; return current }, sessionLost: { lost.append(($0 as? ClientError)?.httpStatus) })
        do { _ = try await switching.act("c", "m1", body); XCTFail("expected 401") } catch {}
        XCTAssertEqual(lost, [401])
    }
    func testRefusalsKeepTheirBodyAndTheSessionContractStays() async throws {
        let c = try client { r, _ in
            switch r.url?.lastPathComponent {
            case "state": return (409, #"{"error":"state_conflict","message":"changed","state":{"seen":true},"version":4}"#)
            case "act": return (428, #"{"error":"confirmation_required","message":"confirm","text":".sc 1/1d6","sheet":true}"#)
            case "close": return (401, #"{"error":"unauthorized","message":"sign in"}"#)
            default: return (404, "<html>Not Found</html>")
            }
        }
        do { _ = try await c.hypertextSave(token: "t", channel: "c", message: "m1", state: ["seen": .bool(false)], baseVersion: 1); XCTFail("expected a conflict") }
        catch {
            let r = H.Refusal(error)
            XCTAssertEqual([String(r.status), r.code], ["409", "state_conflict"]); XCTAssertTrue(r.apiResponse)
            XCTAssertEqual(H.classify(r), .conflict)
            XCTAssertEqual(H.conflictState(r), H.Saved(state: ["seen": .bool(true)], version: 4))
            XCTAssertEqual((error as? ClientError)?.httpStatus, 409)
            XCTAssertEqual((error as? ClientError)?.errorDescription, "changed", "the server's own words")
        }
        let put = try XCTUnwrap(CardProbe.requests.last)
        XCTAssertEqual(put.request.httpMethod, "PUT"); XCTAssertEqual(put.request.url?.path, "/api/channels/c/messages/m1/hypertext/state")
        XCTAssertEqual(String(decoding: put.body, as: UTF8.self), #"{"base_version":1,"state":{"seen":false}}"#, "integers are written without a fraction")
        let body = H.actBody(interactionId: "i1", node: "sanity", effects: [.say(text: ".sc 1/1d6", kind: .ic)], state: [:], baseVersion: 0)
        do { _ = try await c.hypertextAct(token: "t", channel: "c", message: "m1", body: body); XCTFail("expected 428") }
        catch {
            let r = H.Refusal(error)
            XCTAssertEqual(H.classify(r), .confirm)
            XCTAssertEqual(H.confirmFrom(r, body: body), H.Confirm(text: ".sc 1/1d6", kind: .ic, sheet: true))
        }
        XCTAssertEqual(CardProbe.requests.last?.request.httpMethod, "POST")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(CardProbe.requests.last?.body)), body)
        do { _ = try await c.hypertextClose(token: "t", channel: "c", message: "m1"); XCTFail("expected 401") }
        catch { XCTAssertTrue(ConnectionPolicy.invalidatesSession(error), "a 401 still ends the session") }
        do { _ = try await c.hypertextStatus(token: "t", channel: "c", ids: ["a"]); XCTFail("expected 404") }
        catch {
            XCTAssertEqual(H.Refusal(error).apiResponse, false)
            XCTAssertEqual(H.classify(error), .missing, "an older server answers with its own page")
        }
    }
    func testActAndCloseAnswersDecode() async throws {
        let c = try client { r, _ in
            if r.url?.lastPathComponent == "close" { return (200, #"{"message_id":"m1","closes_at":"2099-01-01T00:00:00Z","closed_at":"2026-11-14T10:00:00Z","closed_by":"gm","closed":true}"#) }
            if r.url?.lastPathComponent == "state" { return (404, #"{"error":"not_found","message":"Not found"}"#) }
            return (200, #"{"interaction_id":"i1","replayed":true,"partial":true,"results":[{"type":"say","ok":true,"message":{"id":"r1","content":".ra Spot Hidden","author_name":"Bea","kind":"roll","seq":9,"via_hypertext_id":"m1"}},{"type":"reply","ok":false,"message":null,"error":{"error":"internal","message":"x"}}],"state":{"state":{"seen":true},"version":3}}"#)
        }
        let act = try await c.hypertextAct(token: "t", channel: "c", message: "m1", body: .object([:]))
        XCTAssertEqual([act.interactionId], ["i1"]); XCTAssertTrue(act.replayed); XCTAssertTrue(act.partial)
        XCTAssertEqual(act.messages.map(\.id), ["r1"], "a line the viewer may not read is left out")
        XCTAssertEqual(act.messages.first?.viaHypertextId, "m1")
        XCTAssertEqual(act.state, H.Saved(state: ["seen": .bool(true)], version: 3))
        let closed = try await c.hypertextClose(token: "t", channel: "c", message: "m1")
        XCTAssertEqual(closed, H.Closed(closesAt: "2099-01-01T00:00:00Z", closedAt: "2026-11-14T10:00:00Z"))
        do { _ = try await c.hypertextSave(token: "t", channel: "c", message: "m1", state: [:], baseVersion: 0); XCTFail("expected 404") }
        catch { XCTAssertEqual(H.classify(error), .gone, "the API's own 404: the card is gone") }
    }

    // MARK: - Pushes

    func testTheTwoCardPushesParse() throws {
        let frames = try JSONDecoder().decode(JSONValue.self, from: contracts("fixtures/realtime-events.json"))["events"].array
        let state = try XCTUnwrap(RealtimeEvent.parse(H.jsonText(frames[5])))
        XCTAssertEqual(state.hypertextState, H.StatePush(messageId: frames[5]["message_id"].text, state: ["door": .null, "lamp": .bool(true)], version: 1))
        XCTAssertNil(state.hypertextClosed); XCTAssertNil(state.message)
        let closed = try XCTUnwrap(RealtimeEvent.parse(H.jsonText(frames[6])))
        XCTAssertEqual(closed.hypertextClosed, H.ClosedPush(messageId: frames[6]["message_id"].text, closedAt: "2026-11-14T14:25:47.149433+00:00"))
        XCTAssertNil(closed.hypertextState)
        XCTAssertNil(RealtimeEvent.parse(H.jsonText(frames[2]))?.hypertextState, "an ordinary line is neither")
    }

    // MARK: - Decisions

    func testOutcomesOfAFailedCardRequest() {
        let table: [(H.Refusal, H.Outcome)] = [
            (.init(status: 0, apiResponse: false), .retry), (.init(status: 408), .retry), (.init(status: 500), .retry), (.init(status: 502, apiResponse: false), .retry),
            (.init(status: 405, apiResponse: false), .missing), (.init(status: 405), .missing), (.init(status: 404, apiResponse: false), .missing),
            (.init(status: 403, code: "feature_disabled"), .disabled), (.init(status: 403, code: "forbidden"), .fail), (.init(status: 403, code: "not_an_actor"), .fail),
            (.init(status: 404, code: "not_found"), .gone), (.init(status: 428, code: "confirmation_required"), .confirm),
            (.init(status: 409, code: "interaction_in_progress"), .retry), (.init(status: 409, code: "state_conflict"), .conflict),
            (.init(status: 409, code: "hypertext_closed"), .refetch), (.init(status: 409, code: "runs_exhausted"), .refetch), (.init(status: 409, code: "conflict"), .refetch),
            (.init(status: 400, code: "invalid_state"), .fail), (.init(status: 429, code: "rate_limited"), .fail), (.init(status: 401, code: "unauthorized"), .fail),
        ]
        for (r, o) in table { XCTAssertEqual(H.classify(r), o, "\(r.status) \(r.code) api=\(r.apiResponse)") }
        XCTAssertEqual(H.classify(URLError(.notConnectedToInternet)), .retry)
        XCTAssertEqual(H.classify(URLError(.timedOut)), .retry)
        XCTAssertEqual(H.classify(ClientError.gateway(503)), .retry)
        XCTAssertEqual(H.classify(ClientError.gateway(404)), .missing)
        XCTAssertEqual(H.classify(ClientError.refused(404, j(#"{"error":"not_found"}"#))), .gone)
        XCTAssertEqual(H.classify(ClientError.invalidResponse), .fail, "a success with an unreadable body is not sent again")
        XCTAssertEqual(H.errorText(code: "runs_exhausted", message: "x"), "You already used this.")
        XCTAssertEqual(H.errorText(code: "dice_error", message: "Bad dice"), "Bad dice", "other codes show the server's words")
        XCTAssertEqual(H.errorText(code: nil, message: ""), "This message's action failed.")
        XCTAssertEqual(H.errorText(H.Refusal(ClientError.refused(409, j(#"{"error":"interaction_in_progress","message":"busy"}"#)))), "An action on this message is still being posted. Try again in a moment.")
        XCTAssertEqual(H.errorSentences.count, 10)
        XCTAssertFalse(ReadCachePolicy.keep(["channels", "c", "hypertext"]), "a card's status is never served stale")
        XCTAssertFalse(ReadCachePolicy.keep(["channels", "c", "messages", "m", "hypertext", "state"]))
        XCTAssertEqual(H.retryPauses, [0.6, 1.8, 4.5])
    }
    func testRequestsAndStates() {
        XCTAssertTrue(H.sameState(nil, nil)); XCTAssertFalse(H.sameState(nil, [:])); XCTAssertTrue(H.sameState([:], [:]))
        XCTAssertTrue(H.sameState(["a": .bool(true), "s": j(#"["x","y"]"#)], ["s": j(#"["x","y"]"#), "a": .bool(true)]))
        XCTAssertFalse(H.sameState(["s": j(#"["x","y"]"#)], ["s": j(#"["y","x"]"#)]))
        XCTAssertFalse(H.sameState(["a": .number(1)], ["a": .bool(true)]))
        XCTAssertFalse(H.sameState(["a": .null], ["b": .null]))
        let effects: [H.Effect] = [.say(text: ".ra Spot Hidden", kind: .ic), .reply(id: "hint", slots: ["n": .number(2)])]
        let body = H.actBody(interactionId: "i", node: "roll", effects: effects, state: ["done": .bool(true)], baseVersion: 3, characterId: "bea")
        XCTAssertEqual(body, j(#"{"interaction_id":"i","node":"roll","base_version":3,"state":{"done":true},"say":{"text":".ra Spot Hidden","kind":"ic","character_id":"bea"},"reply":{"id":"hint","slots":{"n":2}}}"#))
        XCTAssertEqual(H.actBody(interactionId: "i", node: "n", effects: [], state: [:], baseVersion: 0, characterId: ""), j(#"{"interaction_id":"i","node":"n","base_version":0,"state":{}}"#))
        XCTAssertEqual(H.confirmed(body)["say"]["confirmed"], .bool(true))
        XCTAssertEqual(H.confirmed(body)["interaction_id"], .string("i"), "a resend keeps the interaction id")
        XCTAssertEqual(H.confirmed(j(#"{"reply":{"id":"x"}}"#)), j(#"{"reply":{"id":"x"}}"#))
        let id = H.newInteractionId()
        XCTAssertNotNil(id.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression), id)
        XCTAssertNotEqual(id, H.newInteractionId())
        // With the server's dice off a dot command is plain text: any say is confirmed, without a sheet warning.
        XCTAssertNil(H.confirmOf(effects: [.say(text: ".ra Spot Hidden", kind: .ic)], confirm: nil))
        XCTAssertEqual(H.confirmOf(effects: [.say(text: ".ra I betray Bob", kind: .ic)], confirm: nil, dice: false), H.Confirm(text: ".ra I betray Bob", kind: .ic))
        XCTAssertNil(H.confirmOf(effects: [.reply(id: "x", slots: [:])], confirm: nil, dice: false))
        // A 428 names the line; sheet false: no sheet warning; without a say there is nothing to confirm.
        XCTAssertEqual(H.confirmFrom(.init(status: 428, body: j(#"{"text":".sc 1/1d6","sheet":false}"#)), body: H.actBody(interactionId: "i", node: "n", effects: [.say(text: ".sc 1/1d6", kind: .ooc)], state: [:], baseVersion: 0)),
                       H.Confirm(text: ".sc 1/1d6", kind: .ooc))
        XCTAssertEqual(H.confirmFrom(.init(status: 428), body: body)?.text, ".ra Spot Hidden")
        XCTAssertNil(H.confirmFrom(.init(status: 428), body: j("{}")))
        XCTAssertEqual(H.conflictState(.init(status: 409, code: "state_conflict")), H.Saved(state: nil, version: 0))
    }
    func testSentencesAreFilledWithIsolatedValues() {
        XCTAssertEqual(H.fill("Post as {name}: {text}", ["name": "Ada", "text": "\u{202e}evil"]), "Post as \u{2068}Ada\u{2069}: \u{2068}\u{202e}evil\u{2069}")
        XCTAssertEqual(H.fill("Uses left: {n}", ["n": "3"], isolated: false), "Uses left: 3")
        XCTAssertEqual(H.fill("{a} {b} {} {x y} {", ["a": "1"]), "\u{2068}1\u{2069} {b} {} {x y} {", "an unknown placeholder is kept as written")
        XCTAssertEqual(H.isolate("x"), "\u{2068}x\u{2069}")
        let confirm = H.Confirm(text: "brb", kind: .ooc)
        XCTAssertEqual(H.confirmLine(confirm, characterName: "Ada", accountName: "Bea").sentence, "Post as {name} (out of character): {text}")
        XCTAssertEqual(H.confirmLine(confirm, characterName: "Ada", accountName: "Bea").values, ["name": "Bea", "text": "brb"], "out of character names the account")
        XCTAssertEqual(H.confirmLine(H.Confirm(text: "hi", kind: .ic), characterName: "Ada", accountName: "Bea").values["name"], "Ada")
        XCTAssertEqual(H.confirmLine(H.Confirm(text: "hi", kind: .ic), characterName: nil, accountName: "Bea").values["name"], "Bea")
    }
    func testServerTimesParse() {
        XCTAssertEqual(H.time("2026-11-14T14:25:47.149433+00:00")?.timeIntervalSince1970 ?? 0, 1794666347.149433, accuracy: 1e-5)
        XCTAssertEqual(H.time("2026-11-21T00:00:00Z")?.timeIntervalSince1970, 1795219200)
        XCTAssertEqual(H.time("2026-11-14T22:25:47+08:00")?.timeIntervalSince1970, 1794666347)
        XCTAssertEqual(H.time("1969-12-31T23:59:59Z")?.timeIntervalSince1970, -1)
        XCTAssertEqual(H.time("2000-02-29T12:00:00.5-05:30")?.timeIntervalSince1970, 951845400.5)
        XCTAssertEqual(H.time("2026-11-14 14:25:47+0000")?.timeIntervalSince1970, 1794666347)
        for bad in ["", "soon", "2026-11-14", "2026-11-14T14:25:47", "2026-13-14T14:25:47Z", "2026-11-14T14:25:47.Z", "2026-11-14T14:25:47Zjunk"] { XCTAssertNil(H.time(bad), bad) }
    }
    func testWhoActsAndAsWhom() throws {
        let (_, plain) = try study()
        XCTAssertTrue(H.isActor(plain, gm: false, characterId: nil), "a card without actors lets everyone act")
        let doc = try XCTUnwrap(H.parseDoc(j(#"{"v":1,"body":[{"type":"divider"}],"actors":["AB12-cd"]}"#)))
        XCTAssertTrue(H.isActor(doc, gm: false, characterId: "ab12-CD"), "compared without case, as the server")
        XCTAssertFalse(H.isActor(doc, gm: false, characterId: "other"))
        XCTAssertFalse(H.isActor(doc, gm: false, characterId: nil))
        XCTAssertTrue(H.isActor(doc, gm: true, characterId: nil), "GMs may always act")
        XCTAssertTrue(H.isActor(try XCTUnwrap(H.parseDoc(j(#"{"v":1,"body":[{"type":"divider"}],"actors":[]}"#))), gm: false, characterId: nil))
        XCTAssertEqual(H.sayCharacter(speakAs: "bea", windowCharacter: "ada", ownCharacters: ["cy"]), "bea")
        XCTAssertEqual(H.sayCharacter(speakAs: "", windowCharacter: "ada", ownCharacters: ["cy"]), "ada")
        XCTAssertEqual(H.sayCharacter(speakAs: nil, windowCharacter: nil, ownCharacters: ["cy", "dee"]), "cy")
        XCTAssertNil(H.sayCharacter(speakAs: nil, windowCharacter: nil, ownCharacters: []))
        XCTAssertEqual(H.sayCharacterToSend("bea", windowCharacter: "ada"), "bea")
        XCTAssertNil(H.sayCharacterToSend("ada", windowCharacter: "ada"), "the server takes the window's character itself")
        XCTAssertNil(H.sayCharacterToSend(nil, windowCharacter: "ada"))
    }

    func testLockReasonsComeInTheCardsOrder() throws {
        let doc = try XCTUnwrap(H.parseDoc(j(#"{"v":1,"state":{"seen":{"type":"bool"}},"body":[{"type":"checkbox","id":"a","label":"A","bind":"seen"},{"type":"button","id":"b","label":"B","act":{"say":"hi"}},{"type":"button","id":"c","label":"C","on":"go"}],"script":"on('go',()=>{})","actors":["pc1"],"runs_per_viewer":3}"#)))
        var loaded = H.CardEntry(channelId: "c"); loaded.loaded = true; loaded.runsLeft = 2
        func reason(_ change: (inout H.CardFacts) -> Void, entry: H.CardEntry? = nil) -> H.CardReason? {
            var f = H.CardFacts(); f.characterId = "pc1"; change(&f)
            return H.present(doc, entry: entry ?? loaded, facts: f).reason
        }
        XCTAssertNil(reason { _ in })
        XCTAssertEqual(reason({ $0.spectator = true; $0.recalled = true }), .spectator)
        XCTAssertEqual(reason({ $0.recalled = true; $0.history = true }), .recalled)
        XCTAssertEqual(reason({ $0.history = true; $0.unavailable = .missing }), .history)
        XCTAssertEqual(reason({ $0.unavailable = .missing; $0.archived = true }), .missing)
        XCTAssertEqual(reason({ $0.unavailable = .disabled }), .disabled)
        var closed = loaded; closed.closedAt = "2026-11-14T00:00:00Z"
        XCTAssertEqual(reason({ $0.archived = true }, entry: closed), .closed)
        var gone = loaded; gone.gone = true
        XCTAssertEqual(reason({ _ in }, entry: gone), .closed, "left out of the status")
        var expired = loaded; expired.closesAt = "2026-11-14T00:00:00Z"
        XCTAssertEqual(reason({ $0.now = H.time("2026-11-14T00:00:01Z")! }, entry: expired), .closed, "closes_at has passed")
        XCTAssertNil(reason({ $0.now = H.time("2026-11-13T23:59:59Z")! }, entry: expired))
        XCTAssertEqual(H.present(doc, entry: expired, facts: { var f = H.CardFacts(); f.characterId = "pc1"; f.now = H.time("2026-11-13T23:59:59Z")!; return f }()).closesAt, H.time("2026-11-14T00:00:00Z"), "drawn again when it closes")
        XCTAssertEqual(reason({ $0.archived = true; $0.paused = true }), .archived)
        XCTAssertEqual(reason({ $0.paused = true }), .paused)
        XCTAssertNil(reason({ $0.paused = true; $0.gm = true }), "a GM is never paused")
        XCTAssertEqual(reason({ $0.member = false; $0.characterId = nil }), .member)
        XCTAssertEqual(reason({ $0.characterId = "pc2" }), .notActor)
        XCTAssertNil(reason({ $0.characterId = "pc2"; $0.gm = true }))
        XCTAssertEqual(reason({ _ in }, entry: H.CardEntry(channelId: "c")), .loading)
        XCTAssertEqual(H.CardReason.member.lock, .notActor); XCTAssertEqual(H.CardReason.missing.lock, .closed); XCTAssertEqual(H.CardReason.disabled.lock, .closed)
        XCTAssertEqual(H.CardReason.member.sentence, "Join this chat window to use this message.")
        XCTAssertEqual(H.CardReason.loading.sentence, "Loading…")
        // A spectator gets the document with its defaults: no status, no state, every control locked.
        var spectator = H.CardFacts(); spectator.spectator = true
        let read = H.present(doc, entry: closed, facts: spectator)
        XCTAssertEqual(read.state, H.defaultState(doc)); XCTAssertTrue(read.resolved.filter { $0.node.isControl }.allSatisfy(\.disabled)); XCTAssertFalse(read.closed)
        XCTAssertFalse(read.showClose); XCTAssertTrue(read.showFooter)
    }
    func testTheFooterAndWhichControlsAreOff() throws {
        let doc = try XCTUnwrap(H.parseDoc(j(#"{"v":1,"state":{"seen":{"type":"bool"}},"body":[{"type":"checkbox","id":"a","label":"A","bind":"seen"},{"type":"button","id":"b","label":"B","act":{"say":"hi"}},{"type":"button","id":"c","label":"C","on":"go"}],"script":"on('go',()=>{})","runs_per_viewer":3}"#)))
        var e = H.CardEntry(channelId: "c"); e.loaded = true; e.runsLeft = 2
        var f = H.CardFacts()
        var card = H.present(doc, entry: e, facts: f)
        XCTAssertEqual(card.off, [false, false, false]); XCTAssertEqual(card.usesLeft, 2); XCTAssertFalse(card.usedUp); XCTAssertFalse(card.noEngine)
        XCTAssertTrue(card.scriptControls); XCTAssertTrue(card.posting); XCTAssertTrue(card.showFooter); XCTAssertFalse(card.showClose)
        // No engine here: only the script's control is off, and the footer says why.
        f.engine = false
        card = H.present(doc, entry: e, facts: f)
        XCTAssertEqual(card.off, [false, false, true]); XCTAssertTrue(card.noEngine)
        // No run left: a button whose act posts is off; the checkbox still works, and so does the script's control (the
        // pipeline answers "You already used this." when its run has lines to post).
        f.engine = true; e.runsLeft = 0
        card = H.present(doc, entry: e, facts: f)
        XCTAssertEqual(card.off, [false, true, false]); XCTAssertTrue(card.usedUp); XCTAssertNil(card.usesLeft)
        // Working, but not while a confirmation waits; both make the card busy.
        e.runsLeft = 1; e.pending = true
        XCTAssertTrue(H.present(doc, entry: e, facts: f).working); XCTAssertTrue(H.present(doc, entry: e, facts: f).busy)
        XCTAssertEqual(H.present(doc, entry: e, facts: f).usesLeft, 1)
        e.confirm = H.Confirm(text: "hi", kind: .ic)
        XCTAssertFalse(H.present(doc, entry: e, facts: f).working); XCTAssertTrue(H.present(doc, entry: e, facts: f).busy)
        // GMs get Close once the status is in, while the card is open, outside fork history and with the feature there.
        e = H.CardEntry(channelId: "c"); e.loaded = true
        f = H.CardFacts(); f.gm = true
        XCTAssertTrue(H.present(doc, entry: e, facts: f).showClose)
        f.history = true; XCTAssertFalse(H.present(doc, entry: e, facts: f).showClose)
        f.history = false; f.unavailable = .disabled; XCTAssertFalse(H.present(doc, entry: e, facts: f).showClose)
        f.unavailable = nil; e.closedAt = "x"; XCTAssertFalse(H.present(doc, entry: e, facts: f).showClose)
        e.closedAt = nil; e.loaded = false; XCTAssertFalse(H.present(doc, entry: e, facts: f).showClose)
        // A card that cannot post shows no run count.
        let quiet = try XCTUnwrap(H.parseDoc(j(#"{"v":1,"state":{"seen":{"type":"bool"}},"body":[{"type":"checkbox","id":"a","label":"A","bind":"seen"}],"runs_per_viewer":3}"#)))
        var q = H.CardEntry(channelId: "c"); q.loaded = true; q.runsLeft = 0
        let drawn = H.present(quiet, entry: q, facts: H.CardFacts())
        XCTAssertFalse(drawn.posting); XCTAssertFalse(drawn.usedUp); XCTAssertNil(drawn.usesLeft); XCTAssertFalse(drawn.showFooter)
    }
    func testEntryTransitions() throws {
        let (_, doc) = try study()
        var e = H.CardEntry(channelId: "c")
        e.apply(H.StatusItem(messageId: "m", state: ["lamp": .bool(true)], version: 2, runsLeft: 1))
        XCTAssertTrue(e.loaded); XCTAssertEqual(e.version, 2)
        XCTAssertFalse(e.adopt(["lamp": .bool(false)], version: 1), "older: ignored")
        XCTAssertFalse(e.adopt(["lamp": .bool(false)], version: 2), "as new: ignored, unless asked")
        XCTAssertTrue(e.adopt(["lamp": .bool(false)], version: 2, orEqual: true))
        let shown = H.shownState(doc, draft: nil, state: e.state)
        var lit = shown; lit["lamp"] = .bool(true)
        e.setDraft(lit, doc: doc, saving: false); XCTAssertEqual(e.draft, lit)
        e.setDraft(shown, doc: doc, saving: false); XCTAssertNil(e.draft, "back to the server's copy: nothing to save")
        e.setDraft(shown, doc: doc, saving: true); XCTAssertEqual(e.draft, shown, "while a save is on its way the draft stays")
        e.draft = lit
        XCTAssertTrue(e.adopt(lit, version: 3)); XCTAssertNil(e.draft, "a draft the server now holds is dropped")
        e.pending = true; e.confirm = H.Confirm(text: "x", kind: .ic)
        e.revert(to: shown, error: "no"); XCTAssertEqual([e.pending, e.confirm == nil], [false, true]); XCTAssertEqual(e.draft, shown); XCTAssertEqual(e.error, "no")
        e.pending = true
        e.finish(H.ActResult(partial: true, state: H.Saved(state: lit, version: 4)))
        XCTAssertEqual([e.version, e.runsLeft], [4, 0]); XCTAssertNil(e.draft); XCTAssertFalse(e.pending); XCTAssertEqual(e.error, "Part of this action could not be posted.")
        e.finish(H.ActResult()); XCTAssertEqual(e.runsLeft, 0, "never below zero"); XCTAssertNil(e.error)
        var unknown = H.CardEntry(channelId: "c"); unknown.finish(H.ActResult()); XCTAssertNil(unknown.runsLeft)
    }
}

/// Answers the card routes of a test client (host cards.test) and records each request with its body.
private final class CardProbe: URLProtocol, @unchecked Sendable {
    struct Seen { let request: URLRequest; let body: Data }
    private static let lock = NSLock()
    private static var reply: @Sendable (URLRequest, Data) -> (Int, String) = { _, _ in (500, "") }
    private static var seen: [Seen] = []
    static var requests: [Seen] { lock.lock(); defer { lock.unlock() }; return seen }
    static func reset(_ r: @escaping @Sendable (URLRequest, Data) -> (Int, String)) { lock.lock(); defer { lock.unlock() }; reply = r; seen = [] }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "cards.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private static func body(_ r: URLRequest) -> Data {
        if let b = r.httpBody { return b }
        guard let s = r.httpBodyStream else { return Data() }
        s.open(); defer { s.close() }
        var out = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while s.hasBytesAvailable { let n = s.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; out.append(buffer, count: n) }
        return out
    }
    override func startLoading() {
        let data = Self.body(request)
        Self.lock.lock(); Self.seen.append(Seen(request: request, body: data)); let answer = Self.reply; Self.lock.unlock()
        let (status, text) = answer(request, data)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
