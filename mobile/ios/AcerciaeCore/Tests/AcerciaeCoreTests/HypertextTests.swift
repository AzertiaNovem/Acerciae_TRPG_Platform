import XCTest
@testable import AcerciaeCore

/// Interactive messages: the Swift port of the card logic (Hypertext.swift) over the shared fixtures
/// contracts/fixtures/hypertext.json (with the server and the other apps) and hypertext-client.json (with the web and
/// Android), plus the hand-written cases of frontend/tests/hypertext-bindings.test.cjs. Every fixture case runs and a
/// failure names it.
final class HypertextTests: XCTestCase {
    private typealias H = Hypertext

    private func fixture(_ name: String) throws -> JSONValue {
        var directory = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { directory.deleteLastPathComponent() }
        let data = try Data(contentsOf: directory.appendingPathComponent("contracts/fixtures/" + name))
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
    private func j(_ text: String) -> JSONValue { (try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .string("<bad test JSON>") }
    private func cases(_ root: JSONValue, _ section: String, file: StaticString = #filePath, line: UInt = #line) -> [JSONValue] {
        let list = root[section].array
        XCTAssertFalse(list.isEmpty, "the fixture has no \(section) cases", file: file, line: line)
        return list
    }
    private func divider(_ decl: JSONValue, showIf: JSONValue? = nil) -> JSONValue {
        var node: [String: JSONValue] = ["type": .string("divider")]
        if let showIf { node["show_if"] = showIf }
        return .object(["v": .number(1), "state": decl, "body": .array([.object(node)])])
    }
    private func doc(_ raw: JSONValue, _ name: String) throws -> H.Doc { try XCTUnwrap(H.parseDoc(raw), "the document of \"\(name)\" does not parse") }
    private func lock(_ v: JSONValue) -> H.LockReason? { v["reason"].string.flatMap(H.LockReason.init(rawValue:)) }
    private func action(_ v: JSONValue) -> H.Action {
        let value = v["value"].text
        switch v["type"].text {
        case "toggle": return .toggle
        case "select": return .select(value)
        case "submit": return .submit(value)
        case "commit": return .commit(value)
        default: return .click
        }
    }

    // The projections the fixtures compare, as frontend/tests/hypertext-bindings.test.cjs builds them.
    private func project(_ r: H.Resolved) -> JSONValue {
        var o: [String: JSONValue] = ["type": .string(r.node.kind.rawValue), "id": r.node.id.map(JSONValue.string) ?? .null, "visible": .bool(r.visible), "disabled": .bool(r.disabled)]
        if let t = r.text { o["text"] = .string(t) }
        if let t = r.label { o["label"] = .string(t) }
        if let t = r.caption { o["caption"] = .string(t) }
        if let v = r.value { o["value"] = v }
        if let options = r.options {
            o["options"] = .array(options.map { .object(["value": .string($0.value), "label": .string($0.label), "selected": .bool($0.selected), "disabled": .bool($0.disabled)]) })
        }
        return .object(o)
    }
    private func project(_ a: H.Applied?) -> JSONValue {
        guard let a else { return .null }
        return .object(["state": .object(a.state), "event": a.event?.json ?? .null])
    }
    private func project(_ a: H.ActOutcome?) -> JSONValue {
        guard let a else { return .null }
        return .object(["state": .object(a.state), "effects": .array(a.effects.map(\.json))])
    }

    // MARK: - Shared fixture (hypertext.json)

    func testSharedFixtureDicePolicy() throws {
        for c in cases(try fixture("hypertext.json"), "dice_policy") {
            XCTAssertEqual(H.verdict(c["text"].text).rawValue, c["verdict"].text, "dice_policy: \(c["text"].text.debugDescription)")
        }
    }
    func testSharedFixtureDefaults() throws {
        for c in cases(try fixture("hypertext.json"), "defaults") {
            let name = c["name"].text
            XCTAssertEqual(JSONValue.object(H.defaultState(try doc(divider(c["state_decl"]), name))), c["state"], "defaults: \(name)")
        }
    }
    func testSharedFixtureStateValidation() throws {
        for c in cases(try fixture("hypertext.json"), "state_validation") {
            let name = c["name"].text
            switch H.validateState(try doc(c["hypertext"], name), c["state"]) {
            case .ok: XCTAssertTrue(c["ok"].bool, "state_validation: \(name) passed but should fail at \(c["error"].text.debugDescription)")
            case .invalid(let key, let error):
                XCTAssertFalse(c["ok"].bool, "state_validation: \(name): \(error)")
                if !c["ok"].bool { XCTAssertEqual(key, c["error"].text, "state_validation: \(name)") }
            }
        }
    }
    func testSharedFixtureConditions() throws {
        for c in cases(try fixture("hypertext.json"), "conditions") {
            let name = c["name"].text
            let d = try doc(divider(c["state_decl"], showIf: c["cond"]), name)
            let cond = try XCTUnwrap(d.body.first?.showIf, "conditions: \(name)")
            XCTAssertEqual(H.evalCondition(cond, d, c["state"].object), c["result"].bool, "conditions: \(name)")
        }
    }
    func testSharedFixtureInterpolation() throws {
        for c in cases(try fixture("hypertext.json"), "interpolation") {
            let name = c["name"].text
            var raw = c["hypertext"].object
            raw["body"] = .array(c["hypertext"]["body"].array + [.object(["type": .string("text"), "text": c["text"]])])
            let d = try doc(.object(raw), name)
            XCTAssertEqual(H.interpolate(c["text"].text, d, c["state"].object), c["result"].text, "interpolation: \(name)")
        }
    }

    // MARK: - Client fixture (hypertext-client.json)

    private func clientDocs() throws -> (JSONValue, [String: H.Doc]) {
        let root = try fixture("hypertext-client.json")
        var docs: [String: H.Doc] = [:]
        for (k, raw) in root["docs"].object { docs[k] = try doc(raw, "docs.\(k)") }
        return (root, docs)
    }
    func testClientFixtureDocumentsParseWithTheServersDefaults() throws {
        let (root, docs) = try clientDocs()
        XCTAssertEqual(docs.count, root["docs"].object.count)
        let study = try XCTUnwrap(docs["study"]), small = try XCTUnwrap(docs["small"])
        XCTAssertEqual(study.body[0].style, "heading")
        XCTAssertEqual(small.body[0].style, "body"); XCTAssertEqual(small.body[0].tone, "neutral")
        XCTAssertEqual(small.body[2].style, "primary")
        XCTAssertEqual(small.runsPerViewer, 1)
        var extra = root["docs"]["small"].object; extra["extra"] = j(#"{"x":1}"#)
        XCTAssertEqual(H.parseDoc(.object(extra)), small, "unknown keys are ignored")
        // Document order: a container comes before its children, and every node knows its place.
        XCTAssertEqual(study.nodes.map(\.index), Array(0..<study.nodes.count))
        XCTAssertEqual(study.nodes.map { $0.id ?? $0.kind.rawValue }, ["intro", "lamp_box", "gear", "tool_pick", "jot", "note_in", "text", "path_pick", "divider", "go", "tell", "ask", "scripted"])
        XCTAssertTrue(H.scripted(try XCTUnwrap(docs["run"])) == false, "a card without a script never starts the engine")
    }
    func testClientFixtureBindings() throws {
        let (root, docs) = try clientDocs()
        let list = cases(root, "bindings")
        XCTAssertGreaterThanOrEqual(list.count, 20)
        for c in list {
            let name = c["name"].text, d = try XCTUnwrap(docs[c["doc"].text], name)
            let got = H.applyAction(d, c["state"].object, c["node"].text, action(c["action"]), lock: lock(c["lock"]))
            XCTAssertEqual(project(got), c["expect"], "bindings: \(name)")
        }
        XCTAssertTrue(list.contains { $0["lock"] != .null } && list.contains { $0["action"]["type"] == .string("commit") })
    }
    func testClientFixtureResolveEveryLockReason() throws {
        let (root, docs) = try clientDocs()
        let list = cases(root, "resolve")
        let reasons = Set(list.map { lock($0["lock"])?.rawValue ?? "none" })
        for r in ["none", "closed", "recalled", "not_actor", "spectator", "history", "archived", "paused", "loading"] { XCTAssertTrue(reasons.contains(r), r) }
        for c in list {
            let name = c["name"].text, d = try XCTUnwrap(docs[c["doc"].text], name)
            let got = H.resolve(d, c["state"].object, lock(c["lock"]))
            XCTAssertEqual(JSONValue.array(got.map(project)), c["expect"], "resolve: \(name)")
            XCTAssertEqual(got.map(\.node.index), Array(0..<got.count), "resolve: \(name): one entry per node, in document order")
        }
    }
    func testClientFixtureAct() throws {
        let (root, docs) = try clientDocs()
        for c in cases(root, "act") {
            let name = c["name"].text, d = try XCTUnwrap(docs[c["doc"].text], name)
            XCTAssertEqual(project(H.act(d, c["state"].object, c["node"].text)), c["expect"], "act: \(name)")
        }
    }
    func testClientOverlay() throws {
        let (root, docs) = try clientDocs()
        let all = cases(root, "overlay")
        XCTAssertGreaterThanOrEqual(all.count, 20)
        for c in all {
            let name = c["name"].text, d = try XCTUnwrap(docs[c["doc"].text], name)
            XCTAssertEqual(H.overlay(d, c["stored"]), c["expect"].object, "overlay: \(name)")
        }
        XCTAssertTrue(all.contains { $0["stored"].object["__proto__"] != nil }, "a case stores prototype names")
    }
    /// The bundle's results for the `runs` cases, checked again natively: confirm and changed are recomputed here.
    func testNativeCheckRecomputesConfirmAndChangedLikeTheBundle() throws {
        let (root, docs) = try clientDocs()
        var checked = 0
        for c in cases(root, "runs") {
            let name = c["name"].text, e = c["expect"]
            let d = try XCTUnwrap(docs[c["doc"].text], name)
            let prev = (c["prev"] == .null ? c["state"] : c["prev"]).object
            guard e["ok"].bool else {
                var error: [String: JSONValue] = ["code": e["code"], "message": .string("x")]
                if e["line"] != .null { error["line"] = e["line"] }
                var out: [String: JSONValue] = ["ok": .bool(false), "error": .object(error)]
                if e["logs"] != .null { out["logs"] = e["logs"] }
                guard case .failed(let err, let logs) = H.validateOutput(d, prev: prev, raw: H.jsonText(.object(out))) else { XCTFail("runs: \(name): a failure stays a failure"); continue }
                XCTAssertEqual(err.code.rawValue, e["code"].text, "runs: \(name)")
                if e["line"] != .null { XCTAssertEqual(err.line, e["line"].int, "runs: \(name)") }
                if e["logs"] != .null { XCTAssertEqual(JSONValue.array(logs.map(JSONValue.string)), e["logs"], "runs: \(name)") }
                continue
            }
            // A result the bundle could have sent: the expected fields, the rest from the case.
            var effects = e["effects"]
            if effects == .null, case .object(let confirm) = e["confirm"] { effects = .array([.object(["type": .string("say"), "text": confirm["text"]!, "kind": confirm["kind"]!])]) }
            if effects == .null && e["confirm"] != .null { continue }
            let state = e["state"] == .null ? c["state"] : e["state"]
            let out: JSONValue = .object(["ok": .bool(true), "state": state, "effects": effects == .null ? .array([]) : effects,
                                          "notices": e["notices"] == .null ? .array([]) : e["notices"], "logs": e["logs"] == .null ? .array([]) : e["logs"],
                                          "confirm": .string("forged"), "changed": .string("forged")])
            guard case .ok(let run) = H.validateOutput(d, prev: prev, raw: H.jsonText(out)) else { XCTFail("runs: \(name): the bundle's result is refused"); continue }
            if e["confirm"] != .null || e.object["confirm"] != nil {
                let confirm: JSONValue = run.confirm.map { c in .object(["text": .string(c.text), "kind": .string(c.kind.rawValue)].merging(c.sheet ? ["sheet": .bool(true)] : [:]) { a, _ in a }) } ?? .null
                XCTAssertEqual(confirm, e["confirm"], "runs: \(name): confirm")
            }
            if e["state"] != .null, e.object["changed"] != nil { XCTAssertEqual(run.changed, e["changed"].bool, "runs: \(name): changed") }
            if e["notices"] != .null { XCTAssertEqual(JSONValue.array(run.notices.map(JSONValue.string)), e["notices"], "runs: \(name)") }
            if e["state"] != .null { XCTAssertEqual(JSONValue.object(run.state), e["state"], "runs: \(name)") }
            checked += 1
        }
        XCTAssertGreaterThan(checked, 20)
    }
    func testEngineVersionAndLimitsMatchTheBundle() throws {
        let engine = try fixture("hypertext-client.json")["engine"]
        XCTAssertEqual(engine["limits"]["output_bytes"].int, H.OutputLimits.bytes)
        XCTAssertEqual(engine["version"].text, H.engineVersion)
        XCTAssertEqual([engine["limits"]["timeout_ms"].int, engine["limits"]["cold_timeout_ms"].int], [Int(H.engineTimeout * 1000), Int(H.engineColdTimeout * 1000)])
        // A host's own answer for a run it gave up on reads like the bundle's.
        let (_, docs) = try clientDocs()
        guard case .failed(let e, _) = H.validateOutput(try XCTUnwrap(docs["run"]), prev: [:], raw: H.failureText(.timeout, "the script did not finish in time")) else { return XCTFail() }
        XCTAssertEqual(e, H.EngineError(code: .timeout, message: "the script did not finish in time", line: nil))
        var directory = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { directory.deleteLastPathComponent() }
        let sums = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: directory.appendingPathComponent("contracts/hypertext/hypertext-engine.sha256.json")))
        XCTAssertTrue(H.jsonText(sums).contains(engine["wasm_sha256"].text), "the packaged bundle carries the fixture's WASM")
    }

    // MARK: - Hand-written cases (hypertext-bindings.test.cjs)

    func testDefaultsAndValidateState() throws {
        let (_, docs) = try clientDocs()
        let d = try XCTUnwrap(docs["study"])
        let defaults: H.State = ["done": .bool(false), "lamp": .bool(false), "count": .number(2), "path": .null, "tools": .array([]), "note": .string("")]
        XCTAssertEqual(H.defaultState(d), defaults)
        XCTAssertEqual(H.overlay(d, nil), defaults)
        XCTAssertEqual(H.validateState(d, defaults), .ok(defaults))
        func key(_ s: JSONValue) -> String? { if case .invalid(let k, _) = H.validateState(d, s) { return k }; return nil }
        func with(_ k: String, _ v: JSONValue) -> JSONValue { .object(defaults.merging([k: v]) { _, b in b }) }
        XCTAssertEqual(key(with("tools", j(#"["rope","lamp","key"]"#))), "tools")
        XCTAssertEqual(key(with("note", .string("\u{2066}x"))), "note")
        XCTAssertEqual(key(with("count", .number(1.5))), "count")
        XCTAssertEqual(key(with("extra", .number(1))), "extra")
        XCTAssertEqual(key(with("lamp", .number(1))), "lamp", "a number is never a bool")
        XCTAssertEqual(key(with("count", .bool(true))), "count", "a bool is never a number")
        XCTAssertEqual(H.validateState(d, j(#"{"count":3,"tools":["key","rope"]}"#)),
                       .ok(defaults.merging(["count": .number(3), "tools": j(#"["rope","key"]"#)]) { _, b in b }), "sets come back in schema order")
        XCTAssertEqual(H.validateState(d, j("{}")), .ok(defaults))
        XCTAssertEqual(key(j(#"{"zz":1,"count":99}"#)), "count", "the first bad key in sorted order")
        XCTAssertEqual(key(j("[1]")), "")
        // At most 8 KiB serialized: five texts of 500 four-byte code points are each valid but too large together.
        let big = try XCTUnwrap(H.parseDoc(j(#"{"v":1,"title":"Big","state":{"t0":{"type":"text","max":500},"t1":{"type":"text","max":500},"t2":{"type":"text","max":500},"t3":{"type":"text","max":500},"t4":{"type":"text","max":500}},"body":[{"type":"input","id":"i","bind":"t0"}]}"#)))
        let emoji = String(repeating: "😀", count: 500)
        let four: H.State = ["t0": .string(""), "t1": .string(emoji), "t2": .string(emoji), "t3": .string(emoji), "t4": .string(emoji)]
        if case .invalid = H.validateState(big, four) { XCTFail("four full texts fit") }
        if case .ok = H.validateState(big, four.merging(["t0": .string(emoji)]) { _, b in b }) { XCTFail("five do not") }
        XCTAssertNil(H.applyAction(big, four, "i", .submit(emoji)))
        XCTAssertEqual(H.applyAction(big, four, "i", .submit("short"))?.state["t0"], .string("short"))
    }

    func testConditionsAndInterpolation() throws {
        let (_, docs) = try clientDocs()
        let d = try XCTUnwrap(docs["study"])
        let s: H.State = ["done": .bool(false), "lamp": .bool(true), "count": .number(3), "path": .string("door"), "tools": j(#"["rope"]"#), "note": .string("")]
        func ev(_ c: H.Cond, _ state: H.State? = nil) -> Bool { H.evalCondition(c, d, state ?? s) }
        XCTAssertTrue(ev(.eq("lamp", .bool(true))))
        XCTAssertFalse(ev(.eq("path", .null)))
        XCTAssertTrue(ev(.isIn("path", [.string("window"), .string("door")])))
        XCTAssertTrue(ev(.has("tools", "rope")))
        XCTAssertTrue(ev(.gte("count", 3)))
        XCTAssertFalse(ev(.lte("count", 2)))
        XCTAssertTrue(ev(.empty("note", true)))
        XCTAssertFalse(ev(.empty("tools", true)))
        XCTAssertTrue(ev(.all([.eq("lamp", .bool(true)), .not(.eq("done", .bool(true)))])))
        XCTAssertFalse(ev(.any([.eq("lamp", .bool(false)), .eq("count", .number(4))])))
        XCTAssertFalse(ev(.eq("constructor", .number(1))))
        XCTAssertFalse(ev(.eq("lamp", .number(1))), "a number never equals a bool")
        XCTAssertEqual(H.interpolate("{{path}}/{{tools}}/{{count}}/{{note}}/{{lamp}}/{{nope}}/{{ path }}", d, s), "The door/Rope/3//{{lamp}}/{{nope}}/{{ path }}")
        XCTAssertEqual(H.interpolate("{{tools}}", d, s.merging(["tools": j(#"["key","rope"]"#)]) { _, b in b }), "Rope, Key")
        XCTAssertEqual(H.interpolate("{{count}}", d, s.merging(["count": .number(-0.0)]) { _, b in b }), "0")
        XCTAssertEqual(H.interpolate("{{{count}}}", d, s), "{{{count}}}")
        XCTAssertEqual(H.interpolate("{{count}} {{{{path}}", d, s), "3 {{The door")
        XCTAssertEqual(H.interpolate("{{count}}/{{path}}/{{tools}}", d, ["note": .string("x")]), "2//")
        XCTAssertEqual(H.interpolate("{{count}}", d, ["count": .string("x")]), "2")
        XCTAssertTrue(H.evalCondition(.eq("count", .number(2)), d, [:]))
        XCTAssertTrue(H.evalCondition(.empty("path", true), d, ["path": .string("nope")]))
    }

    func testTextRules() {
        XCTAssertEqual(H.cpLength("a😀é"), 3)
        XCTAssertEqual(H.cpPrefix("😀😀😀", 2), "😀😀")
        XCTAssertEqual(H.utf8Bytes("aé😀中"), 1 + 2 + 4 + 3)
        // Noncharacters cannot be written as Swift literals: they are built from their code points.
        let nonchar = { (v: UInt32) in String(Unicode.Scalar(v)!) }
        for bad in ["\u{0}", "\t", "\r", "\u{1f}", "\u{202a}", "\u{202e}", "\u{2066}", "\u{2069}"] + [0xfdd0, 0xfdef, 0xfffe, 0xffff, 0x1fffe, 0x10ffff].map(nonchar) {
            XCTAssertFalse(H.textOk("a" + bad), bad.unicodeScalars.map { String($0.value, radix: 16) }.joined())
        }
        for good in ["plain", "中文 😀", "\u{7f}", "\u{200f}", "😀", "é"] { XCTAssertTrue(H.textOk(good), good) }
        XCTAssertFalse(H.textOk("a\nb")); XCTAssertTrue(H.textOk("a\nb", multiline: true))
        XCTAssertFalse(H.textOk("a\r\nb", multiline: true), "a CR is refused even beside a line feed")
        XCTAssertEqual(H.sanitize("a\u{202e}b" + nonchar(0xffff) + "c"), "a\u{fffd}b\u{fffd}c")
        XCTAssertEqual(H.asciiTrim(" \t\n.r 1d6\u{0b}\u{0c}\r "), ".r 1d6")
        XCTAssertEqual(H.asciiTrim("\u{3000}.r\u{a0}"), "\u{3000}.r\u{a0}")
        for id in ["a", "roll_2", String(repeating: "a", count: 32)] { XCTAssertTrue(H.isId(id), id) }
        for id in ["", "A", "1a", "_a", "a-b", String(repeating: "a", count: 33), "__proto__", "constructor", "prototype", "valueof", "tostring", "hasownproperty",
                   "isprototypeof", "propertyisenumerable", "tolocalestring", "__definegetter__", "toString", "a\n", "é"] { XCTAssertFalse(H.isId(id), id) }
        XCTAssertEqual(H.lineCount("a\nb\u{2028}c\u{2029}d\u{85}e\rf"), 5)
        XCTAssertEqual(H.jsonDepth(#"[{"a":"[[["}]"#), 2)
        XCTAssertEqual(H.jsonDepth(#"{"a":"\"[["}"#), 1)
        // JSON as JavaScript writes it: integers without a fraction, the same escapes, sizes in UTF-8 bytes.
        XCTAssertEqual(H.jsonText(j(#"{"b":[1,-0,2.5,true,null],"a":"q\"\\\n\u0001\#u{2028}😀"}"#)), "{\"a\":\"q\\\"\\\\\\n\\u0001\u{2028}😀\",\"b\":[1,0,2.5,true,null]}")
        XCTAssertEqual(H.jsonText(.number(1e9)), "1000000000")
    }

    func testCardValuesCompareByCodeUnitAsOnTheWeb() throws {
        // "\u{E9}" and "e\u{301}" are canonically equivalent: Swift's String == calls them equal, JavaScript, the server
        // and Android do not, so neither may the port.
        let nfc = "\u{E9}", nfd = "e\u{301}"
        XCTAssertFalse(H.same(nfc, nfd)); XCTAssertTrue(H.same(nfc, "\u{E9}"))
        XCTAssertFalse(H.same(.array([.string(nfc)]), .array([.string(nfd)])))
        XCTAssertFalse(H.same(.object(["a": .string(nfc)]), .object(["a": .string(nfd)])))
        XCTAssertTrue(H.same(.object(["a": .array([.number(1), .null])]), .object(["a": .array([.number(1), .null])])))
        let two = try XCTUnwrap(H.parseDoc(j(#"{"v":1,"state":{"pick":{"type":"enum","values":[{"value":"\u00e9"},{"value":"e\u0301"}]}},"body":[{"type":"choice","id":"c","bind":"pick","options":["\u00e9","e\u0301"]}]}"#)),
                              "two values that differ by code unit are two values, as on the web")
        XCTAssertEqual(two.state["pick"]?.values.count, 2)
        XCTAssertNil(H.parseDoc(j(#"{"v":1,"state":{"pick":{"type":"enum","values":[{"value":"\u00e9"},{"value":"\u00e9"}]}},"body":[{"type":"divider"}]}"#)))
        let d = try XCTUnwrap(H.parseDoc(j(#"{"v":1,"state":{"pick":{"type":"enum","values":[{"value":"\u00e9","label":"E"},{"value":"b"}]},"tags":{"type":"set","values":[{"value":"\u00e9"},{"value":"b"}],"max":2},"t":{"type":"text","max":10}},"body":[{"type":"choice","id":"c","bind":"pick"},{"type":"choice","id":"g","bind":"tags"}]}"#)))
        func invalid(_ s: JSONValue) -> String? { if case .invalid(let k, _) = H.validateState(d, s) { return k }; return nil }
        XCTAssertEqual(invalid(j(#"{"pick":"e\u0301"}"#)), "pick")
        XCTAssertEqual(invalid(j(#"{"tags":["e\u0301"]}"#)), "tags")
        XCTAssertNil(invalid(j(#"{"pick":"\u00e9","tags":["\u00e9"]}"#)))
        XCTAssertFalse(H.evalCondition(.eq("pick", .string(nfd)), d, ["pick": .string(nfc)]))
        XCTAssertTrue(H.evalCondition(.eq("pick", .string(nfc)), d, ["pick": .string(nfc)]))
        XCTAssertFalse(H.evalCondition(.isIn("pick", [.string(nfd)]), d, ["pick": .string(nfc)]))
        XCTAssertFalse(H.evalCondition(.has("tags", nfd), d, ["tags": .array([.string(nfc)])]))
        XCTAssertEqual(H.interpolate("{{pick}}", d, ["pick": .string(nfc)]), "E")
        XCTAssertEqual(H.interpolate("{{pick}}", d, ["pick": .string(nfd)]), "", "not a declared value: the default, null")
        XCTAssertNil(H.applyAction(d, H.defaultState(d), "c", .select(nfd)))
        XCTAssertTrue(H.same(H.applyAction(d, H.defaultState(d), "c", .select(nfc))?.state["pick"], .string(nfc)))
        XCTAssertFalse(H.sameState(["t": .string(nfc)], ["t": .string(nfd)]))
        // The native check sees a text changed to its other form as a change.
        let prev: H.State = ["pick": .null, "tags": .array([]), "t": .string(nfc)]
        guard case .ok(let run) = H.validateOutput(d, prev: prev, raw: #"{"ok":true,"state":{"pick":null,"tags":[],"t":"e\u0301"}}"#) else { return XCTFail() }
        XCTAssertTrue(run.changed)
    }

    func testMalformedOrUnknownDocumentsAreNilNeverAThrow() throws {
        let (root, _) = try clientDocs()
        let base = root["docs"]["small"].object
        func with(_ k: String, _ v: JSONValue) -> JSONValue { .object(base.merging([k: v]) { _, b in b }) }
        func body(_ b: String) -> JSONValue { with("body", j(b)) }
        func state(_ s: String) -> JSONValue { with("state", j(s)) }
        let malformed: [String: JSONValue] = [
            "not an object": .string("card"), "array": .array([.object(base)]), "null": .null,
            "unknown version": with("v", .number(2)), "version as a string": with("v", .string("1")), "version as true": with("v", .bool(true)),
            "title too long": with("title", .string(String(repeating: "x", count: 121))), "bidi in the title": with("title", .string("a\u{202e}b")),
            "title null": with("title", .null),
            "empty body": body("[]"), "body not a list": body("{}"),
            "a __proto__ key": j(#"{"v":1,"title":"x","state":{"__proto__":{"type":"bool"}},"body":[{"type":"divider"}]}"#),
            "a constructor key": state(#"{"constructor":{"type":"bool"}}"#), "a valueof key": state(#"{"valueof":{"type":"bool"}}"#),
            "an uppercase key": state(#"{"Seen":{"type":"bool"}}"#),
            "too many keys": state("{" + (0..<33).map { "\"k\($0)\":{\"type\":\"bool\"}" }.joined(separator: ",") + "}"),
            "unknown state type": state(#"{"seen":{"type":"float"}}"#),
            "int bounds reversed": state(#"{"seen":{"type":"int","min":2,"max":1}}"#), "int beyond 1e9": state(#"{"seen":{"type":"int","min":0,"max":1000000001}}"#),
            "int default out of range": state(#"{"seen":{"type":"int","min":0,"max":3,"default":4}}"#),
            "int default null": state(#"{"seen":{"type":"int","min":0,"max":3,"default":null}}"#),
            "int bound true": state(#"{"seen":{"type":"int","min":true,"max":3}}"#),
            "enum with one value": state(#"{"seen":{"type":"enum","values":[{"value":"a","label":"A"}]}}"#),
            "enum duplicate values": state(#"{"seen":{"type":"enum","values":[{"value":"a","label":"A"},{"value":"a","label":"B"}]}}"#),
            "enum default not declared": state(#"{"seen":{"type":"enum","values":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"default":"c"}}"#),
            "set max 0": state(#"{"seen":{"type":"set","values":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"max":0}}"#),
            "text max 501": state(#"{"seen":{"type":"text","max":501}}"#),
            "unknown node type": body(#"[{"type":"image","id":"i"}]"#),
            "duplicate node ids": body(#"[{"type":"checkbox","id":"a","label":"A","bind":"seen"},{"type":"checkbox","id":"a","label":"B","bind":"seen"}]"#),
            "control without an id": body(#"[{"type":"checkbox","label":"A","bind":"seen"}]"#),
            "bind to an undeclared key": body(#"[{"type":"checkbox","id":"a","label":"A","bind":"gone"}]"#),
            "bind to a prototype name": body(#"[{"type":"checkbox","id":"a","label":"A","bind":"constructor"}]"#),
            "checkbox bound to a text": .object(base.merging(["state": j(#"{"t":{"type":"text","max":5}}"#), "body": j(#"[{"type":"checkbox","id":"a","label":"A","bind":"t"}]"#)]) { _, b in b }),
            "button with on and act": body(#"[{"type":"button","id":"b","label":"B","on":"x","act":{"say":"hi"}}]"#),
            "button with neither": body(#"[{"type":"button","id":"b","label":"B"}]"#),
            "button with on null": body(#"[{"type":"button","id":"b","label":"B","on":null}]"#),
            "button label over 60": body("[{\"type\":\"button\",\"id\":\"b\",\"label\":\"\(String(repeating: "x", count: 61))\",\"on\":\"x\"}]"),
            "act with nothing": body(#"[{"type":"button","id":"b","label":"B","act":{}}]"#),
            "act set of the wrong type": body(#"[{"type":"button","id":"b","label":"B","act":{"set":{"seen":1}}}]"#),
            "act reply not declared": body(#"[{"type":"button","id":"b","label":"B","act":{"reply":"nope"}}]"#),
            "act say_kind narration": body(#"[{"type":"button","id":"b","label":"B","act":{"say":"x","say_kind":"narration"}}]"#),
            "act say over 500": body("[{\"type\":\"button\",\"id\":\"b\",\"label\":\"B\",\"act\":{\"say\":\"\(String(repeating: "x", count: 501))\"}}]"),
            "act say of only spaces": body(#"[{"type":"button","id":"b","label":"B","act":{"say":" \t\r\n"}}]"#),
            "act say with a line break inside": body(#"[{"type":"button","id":"b","label":"B","act":{"say":".r 1d6\r\nx"}}]"#),
            "a value label that is not a string": state(#"{"seen":{"type":"enum","values":[{"value":"a","label":1},{"value":"b"}]}}"#),
            "a row inside a row": body(#"[{"type":"row","children":[{"type":"row","children":[]}]}]"#),
            "a group inside a group": body(#"[{"type":"group","children":[{"type":"group","children":[]}]}]"#),
            "a group inside a row": body(#"[{"type":"row","children":[{"type":"group","children":[]}]}]"#),
            "more than 64 nodes": body("[" + Array(repeating: #"{"type":"divider"}"#, count: 65).joined(separator: ",") + "]"),
            "condition on an undeclared key": body(#"[{"type":"divider","show_if":{"key":"gone","eq":true}}]"#),
            "condition of the wrong type": body(#"[{"type":"divider","show_if":{"key":"seen","eq":1}}]"#),
            "condition with two operators": body(#"[{"type":"divider","show_if":{"key":"seen","eq":true,"empty":true}}]"#),
            "unknown condition operator": body(#"[{"type":"divider","show_if":{"key":"seen","like":true}}]"#),
            "condition deeper than 3": body(#"[{"type":"divider","show_if":{"not":{"not":{"not":{"key":"seen","eq":true}}}}}]"#),
            "more than 8 leaves": body(#"[{"type":"divider","show_if":{"any":["# + Array(repeating: #"{"key":"seen","eq":true}"#, count: 9).joined(separator: ",") + "]}}]"),
            "has on a bool": body(#"[{"type":"text","text":"x","show_if":{"key":"seen","has":"a"}}]"#),
            "show_if null": body(#"[{"type":"divider","show_if":null}]"#),
            "enable_if on a control of the wrong type": body(#"[{"type":"checkbox","id":"a","label":"A","bind":"seen","enable_if":{"key":"seen","gte":1}}]"#),
            "choice options not declared": .object(base.merging(["state": j(#"{"p":{"type":"enum","values":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}}"#), "body": j(#"[{"type":"choice","id":"c","bind":"p","options":["c"]}]"#)]) { _, b in b }),
            "script over 16 KiB": with("script", .string(String(repeating: "x", count: 16385))),
            "runs_per_viewer 0": with("runs_per_viewer", .number(0)), "runs_per_viewer 101": with("runs_per_viewer", .number(101)),
            "runs_per_viewer 1.5": with("runs_per_viewer", .number(1.5)),
            "more than 10 actors": with("actors", .array((0..<11).map { .string(String($0)) })),
            "reply stub with a bad slot": with("replies", j(#"[{"id":"r","slots":{"n":{"type":"int","min":3,"max":1}}}]"#)),
            "duplicate reply stubs": with("replies", j(#"[{"id":"r","slots":{}},{"id":"r","slots":{}}]"#)),
        ]
        for (name, raw) in malformed { XCTAssertNil(H.parseDoc(raw), name) }
        // Accepted: the same documents written correctly.
        XCTAssertNotNil(H.parseDoc(body(#"[{"type":"row","children":[{"type":"text","text":"a"},{"type":"checkbox","id":"a","label":"A","bind":"seen","enable_if":{"key":"seen","eq":false}}]}]"#)))
        XCTAssertNotNil(H.parseDoc(body(#"[{"type":"divider","show_if":{"not":{"not":{"key":"seen","eq":true}}}}]"#)))
        let full = try XCTUnwrap(H.parseDoc(.object(base.merging(["script": .string(String(repeating: "é", count: 8192)), "closes_at": .string("2026-11-21T00:00:00Z"),
                                                                 "actors": j(#"["c1"]"#), "runs_per_viewer": .number(100)]) { _, b in b })))
        XCTAssertEqual([full.actors, full.closesAt, full.runsPerViewer] as [AnyHashable?], [["c1"], "2026-11-21T00:00:00Z", 100])
        XCTAssertEqual(H.parseDoc(with("actors", .array([])))?.actors, [], "an empty list of actors stays a list")
        XCTAssertNil(H.parseDoc(with("script", .string("")))?.script, "an empty script is no script")
        XCTAssertEqual(H.Limits.nodes, 64)
        // What the server's normalize fills in, so a post body reads like the stored card: no title, labels from values.
        let post = try XCTUnwrap(H.parseDoc(j(#"{"v":1,"state":{"p":{"type":"enum","values":[{"value":"a"},{"value":"b","label":"Bee"}]}},"body":[{"type":"choice","id":"c","bind":"p"}]}"#)))
        XCTAssertEqual(post.title, "")
        XCTAssertEqual(post.state["p"], .enumeration(values: [.init(value: "a", label: "a"), .init(value: "b", label: "Bee")], default: nil))
        XCTAssertEqual(post.body[0].display, "list")
        // act.say is checked and kept ASCII-trimmed, as the server checks the trimmed say and posts it.
        for raw in [".ra Spot Hidden\r\n", "\t.r 1d6", ".r 1d6" + String(repeating: " ", count: 600)] {
            let d = try XCTUnwrap(H.parseDoc(body("[{\"type\":\"button\",\"id\":\"b\",\"label\":\"B\",\"act\":{\"say\":\(H.jsonText(.string(raw)))}}]")), raw.debugDescription)
            XCTAssertEqual(d.body[0].act?.say, H.asciiTrim(raw))
        }
    }

    // MARK: - Dice (a mirror of dice::parseCommand)

    func testParseCommandMirrorsTheServerLiteralsOrderAndNextCharacterRule() {
        let list: [(String, String, String, Bool)] = [
            (".r", "r", "", false), (".r1d6", "r", "1d6", false), (".rd20", "r", "d20", false), (".RD20", "r", "D20", false), (".rh", "r", "", true), (".rh 1d4", "r", "1d4", true),
            (".ra Spot Hidden", "ra", "Spot Hidden", false), (".RA spot", "ra", "spot", false), (".rah Listen", "ra", "Listen", true), (".rch", "ra", "", true), (".rc 50", "ra", "50", false),
            (".ri", "ri", "", false), (".rih", "ri", "", true), (".ri+3", "ri", "+3", false), (".sc 1/1d6", "sc", "1/1d6", false), (".st STR 50", "st", "STR 50", false),
            (".en Library", "en", "Library", false), (".ds", "ds", "", false), (".ss", "ss", "", false), (".init", "init", "", false), (".move 3", "move", "3", false),
            ("。ra 侦查", "ra", "侦查", false), ("．r", "r", "", false), ("  .r 2d6  ", "r", "2d6", false), (".ra侦查", "ra", "侦查", false), (".r(1d6)", "r", "(1d6)", false),
            (".r%", "r", "%", false), (".r#2", "r", "#2", false), (".r/2", "r", "/2", false), (".r-1", "r", "-1", false), (".ra\tx", "ra", "x", false), (".ri\u{0}", "ri", "\u{0}", false),
            ("。r\u{301}", "r", "\u{301}", false),
        ]
        for (text, name, args, hidden) in list {
            guard let c = H.parseCommand(text) else { XCTFail(text.debugDescription); continue }
            XCTAssertEqual([c.name, c.args], [name, args], text.debugDescription); XCTAssertEqual(c.hidden, hidden, text.debugDescription)
        }
        for text in ["", ".", "。", "r", "..r", "\u{3000}.r", ".rx", ".rcx", ".rhx", ".rend", ".endurance", ".inita", ".stx", ".r\u{0b}x", "hello .r", ".Ｒ", "。\u{301}ra"] {
            XCTAssertNil(H.parseCommand(text), text.debugDescription)
        }
        XCTAssertEqual(H.parseCommand(".rah")?.raw, ".rah")
    }
    func testDicePolicyForLinesPostedAsTheClicker() {
        let policy: [H.Verdict: [String]] = [
            .allowed: [".r", ".rh", ".r 1d100", ".r 2d6+3 for damage", ".ra Spot Hidden", ".rc 50", ".rah", ".rch", ".ri", ".rih", ".ri +2", ".ri -1 +3", ".ri+1", ".RI +10", "。ri",
                       ".ri +9999", ".ri +12345", ".ri +1d4", ".ri -d6", ".ri adv", ".ri ADV", ".ri +2 adv", ".ri adv+2", ".ri disadvantage -1", ".ri dis", ".ri + 2"],
            .confirm: [".sc 1/1d6", ".ds", "．SC"],
            .refused: [".ri Bob", ".ri 3", ".ri +2 Bob", ".rih Alice", ".ri adv2", ".ri +2abc", ".ri +2d", ".ri +", ".ri advantages", ".ri #quick", ".ri 优势", ".ri adv\u{a0}",
                       ".st STR 50", ".en", ".ss", ".init", ".move", ".MOVE 2"],
            .none: ["hello", "I open the door.", ".rx", "", "。", ". r", ".resume"],
        ]
        for (v, texts) in policy { for t in texts { XCTAssertEqual(H.verdict(t), v, t.debugDescription) } }
        XCTAssertTrue(H.modifiersOnly(""))
        XCTAssertTrue(H.modifiersOnly(" +2\t-1 "))
    }
    func testABareRollRunsDirectlyAndAnyOtherTextRidingOnARollIsConfirmed() {
        let bare = [".r", ".r 1d100", ".rd6", ".r(1d6+2)*3", ".r 3#1d6", ".r 3# 2d6", ".rh 1d20", ".r%", ".ra Spot Hidden", ".rah Listen", "。ra侦查",
                    ".ra Fighting (Brawl) 50 +10", ".ra Operate Heavy Machinery 50 - 5", ".ra " + String(repeating: "x", count: 32), ".ri", ".ri adv +2", "  .r 1d6  "]
        let riding = [".r 2d6+3 for damage", ".r 1d6 +2", ".r I hand all my gold to the GM", ".r 1d6\nSigned, me", ".ra Spot Hidden\nand more",
                      ".ra " + String(repeating: "x", count: 33), ".ra I hand all my gold to the GM", ".ra Spot Hidden for the clue", ".r 1d6\u{2028}x", ".ra x\u{2029}y", ".ri +2\nadv", ".r１d6", ".sc 1/1d6", ".st x", "hello"]
        for t in bare { XCTAssertTrue(H.bareRoll(t), t.debugDescription) }
        for t in riding { XCTAssertFalse(H.bareRoll(t), t.debugDescription) }
    }

    // MARK: - Host validation, natively

    func testEffectsAndConfirmations() throws {
        let (_, docs) = try clientDocs()
        let run = try XCTUnwrap(docs["run"])
        func fx(_ s: String) -> Result<[H.Effect], H.Invalid> { H.checkEffects(run, j(s)) }
        XCTAssertEqual(try fx(#"[{"type":"say","text":"  .r 1d6 ","kind":"ic"},{"type":"reply","id":"clue","slots":{"mark":"13"}}]"#).get(),
                       [.say(text: ".r 1d6", kind: .ic), .reply(id: "clue", slots: ["mark": .string("13")])])
        XCTAssertEqual(try fx(#"[{"type":"reply","id":"door"}]"#).get(), [.reply(id: "door", slots: [:])], "a reply without slots")
        for bad in [#"[{"type":"say","text":"a","kind":"ic"},{"type":"say","text":"b","kind":"ic"}]"#, #"[{"type":"say","text":"a","kind":"narration"}]"#,
                    #"[{"type":"say","text":"a","kind":"ic","character_id":"x"}]"#, #"[{"type":"say","text":".st STR 90","kind":"ic"}]"#,
                    #"[{"type":"say","text":"a\nb\nc\nd\ne\nf","kind":"ic"}]"#, #"[{"type":"say","text":"   ","kind":"ic"}]"#,
                    #"[{"type":"reply","id":"nope"}]"#, #"[{"type":"reply","id":"clue","slots":{"mark":"99"}}]"#, #"[{"type":"reply","id":"clue","slots":{}}]"#,
                    #"[{"type":"reply","id":"num","slots":{"n":2.5}}]"#, #"[{"type":"reply","id":"door","slots":null}]"#, #"[{"type":"reply","id":"door","text":"forged"}]"#,
                    #"[{"type":"emote"}]"#, #"[1]"#, #"{"type":"say"}"#, #"[{},{},{}]"#] {
            if case .success = fx(bad) { XCTFail(bad) }
        }
        // A null enum slot from a declarative act is refused when checked.
        let study = try XCTUnwrap(docs["study"])
        let asked = try XCTUnwrap(H.act(study, H.defaultState(study), "ask"))
        if case .success = H.checkEffects(study, effects: asked.effects) { XCTFail("a null slot") }
        XCTAssertNil(H.confirmFor([.say(text: ".ra Spot Hidden", kind: .ic)]))
        XCTAssertEqual(H.confirmFor([.say(text: ".sc 1/1d6", kind: .ic)]), H.Confirm(text: ".sc 1/1d6", kind: .ic, sheet: true))
        XCTAssertEqual(H.confirmFor([.reply(id: "door", slots: [:]), .say(text: "brb", kind: .ooc)]), H.Confirm(text: "brb", kind: .ooc))
        XCTAssertNil(H.confirmFor([.reply(id: "door", slots: [:])]))
    }

    func testTheNativeCheckRefusesWhatTheBundleShouldNeverSend() throws {
        let (_, docs) = try clientDocs()
        let d = try XCTUnwrap(docs["run"])
        let prev = H.defaultState(d)
        let state = #""state":{"done":true,"n":0,"pick":null,"tags":[],"t":""}"#
        func code(_ raw: String?) -> String {
            switch H.validateOutput(d, prev: prev, raw: raw) { case .ok: "ok"; case .failed(let e, _): e.code.rawValue }
        }
        XCTAssertEqual(code(#"{"ok":true,\#(state),"effects":[],"notices":[],"logs":[],"confirm":null,"changed":true}"#), "ok")
        XCTAssertEqual(code(nil), "engine")
        XCTAssertEqual(code("not json"), "invalid_effect")
        XCTAssertEqual(code(#"{"state":{}}"#), "invalid_effect", "no ok")
        XCTAssertEqual(code(#"{"ok":1}"#), "invalid_effect", "ok must be a boolean")
        XCTAssertEqual(code(#"{"ok":true,\#(state),"extra":1}"#), "invalid_effect")
        XCTAssertEqual(code(#"{"ok":true,"state":{"done":true}}"#), "invalid_state", "a deleted key")
        XCTAssertEqual(code(#"{"ok":true,"state":{"done":1,"n":0,"pick":null,"tags":[],"t":""}}"#), "invalid_state")
        XCTAssertEqual(code(#"{"ok":true,\#(state),"effects":[{"type":"say","text":".st STR 99","kind":"ic"}]}"#), "invalid_effect")
        XCTAssertEqual(code(#"{"ok":true,\#(state),"notices":["a","b","c","d"]}"#), "invalid_effect")
        XCTAssertEqual(code(#"{"ok":true,\#(state),"notices":[""]}"#), "invalid_effect")
        XCTAssertEqual(code(#"{"ok":true,\#(state),"logs":null}"#), "invalid_effect")
        XCTAssertEqual(code(#"{"ok":true,\#(state),"logs":[1]}"#), "invalid_effect")
        XCTAssertEqual(code(String(repeating: "[", count: 17) + String(repeating: "]", count: 17)), "invalid_effect")
        XCTAssertEqual(code(#"{"ok":true,\#(state),"logs":["\#(String(repeating: "x", count: 70000))"]}"#), "invalid_effect", "over 64 KiB")
        // The forged confirm and changed are ignored: both are computed here.
        guard case .ok(let r) = H.validateOutput(d, prev: prev, raw: #"{"ok":true,\#(state),"effects":[{"type":"say","text":"I open the door.","kind":"ic"}],"confirm":null,"changed":false}"#) else { return XCTFail() }
        XCTAssertEqual(r.confirm, H.Confirm(text: "I open the door.", kind: .ic)); XCTAssertTrue(r.changed)
        // Failures keep a known code, a positive line, sanitized and cut messages and logs.
        guard case .failed(let e, let logs) = H.validateOutput(d, prev: prev, raw: #"{"ok":false,"error":{"code":"made_up","message":"bad\#u{202E}\#(String(repeating: "x", count: 300))","line":3},"logs":["a\u0000",{"k":1}]}"#) else { return XCTFail() }
        XCTAssertEqual(e.code, .scriptError); XCTAssertEqual(e.line, 3)
        XCTAssertEqual(H.cpLength(e.message), 200); XCTAssertTrue(e.message.hasPrefix("bad\u{fffd}"))
        XCTAssertEqual(logs, ["a\u{fffd}", #"{"k":1}"#])
        guard case .failed(let e2, _) = H.validateOutput(d, prev: prev, raw: #"{"ok":false,"error":{"code":"budget","line":0}}"#) else { return XCTFail() }
        XCTAssertEqual([e2.code.rawValue, e2.message], ["budget", "the script failed"]); XCTAssertNil(e2.line)
    }

    func testEngineRequestCarriesTheDocumentAndBothStates() throws {
        let (root, docs) = try clientDocs()
        let d = try XCTUnwrap(docs["run"])
        let applied = try XCTUnwrap(H.applyAction(d, H.defaultState(d), "go", .click))
        let json = try XCTUnwrap(H.engineRequest(doc: root["docs"]["run"], state: applied.state, prev: H.defaultState(d), handler: "go", event: try XCTUnwrap(applied.event),
                                                 viewer: H.Viewer(gm: false, actor: true, character: "Ada")))
        let back = j(json)
        XCTAssertEqual(back["doc"], root["docs"]["run"])
        XCTAssertEqual(back["event"], j(#"{"type":"click","node":"go","value":null}"#))
        XCTAssertEqual(back["viewer"], j(#"{"gm":false,"actor":true,"character":"Ada"}"#))
        XCTAssertEqual(back["handler"], .string("go")); XCTAssertEqual(back["prev"].object, H.defaultState(d))
        let huge: H.State = ["t": .string(String(repeating: "x", count: 70000))]
        XCTAssertNil(H.engineRequest(doc: root["docs"]["run"], state: huge, prev: [:], handler: "go", event: try XCTUnwrap(applied.event), viewer: H.Viewer(gm: false, actor: true, character: nil)))
    }
}
