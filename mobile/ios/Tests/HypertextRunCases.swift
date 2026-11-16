import Foundation
import AcerciaeCore

/// The engine cases of mobile/contracts/fixtures/hypertext-client.json ("runs") as the app's engine host meets them:
/// the request a host sends to `MobileHypertext.run`, and whether the result, checked natively
/// (`Hypertext.validateOutput`), is what the case expects (engine.test.mjs `check`). Foundation and AcerciaeCore only, so
/// that the same comparison can also be run off the simulator.
enum HypertextRunCases {
    struct Case {
        let name: String
        /// The case's card: the fixture's doc with the case's script in place of its own.
        let raw: JSONValue
        let doc: Hypertext.Doc
        /// The state shown before the action (the case's `prev`, else its `state`).
        let prev: Hypertext.State
        /// `{doc, state, prev, handler, event, viewer}`, as a host sends it.
        let request: String
        let expect: JSONValue
    }
    struct Malformed: Error, CustomStringConvertible { let description: String }

    /// The fixture, found by walking up from this file to the folder that holds `mobile/contracts`.
    static func fixture(from file: String = #filePath) throws -> JSONValue {
        var directory = URL(fileURLWithPath: file).deletingLastPathComponent()
        while directory.pathComponents.count > 1 {
            let candidate = directory.appendingPathComponent("mobile/contracts/fixtures/hypertext-client.json")
            if FileManager.default.fileExists(atPath: candidate.path) { return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: candidate)) }
            directory.deleteLastPathComponent()
        }
        throw Malformed(description: "mobile/contracts/fixtures/hypertext-client.json not found above \(file)")
    }

    /// The cases whose answer depends neither on the machine's speed nor on heavy work: no budget, memory, stack or
    /// deadline cut-offs, and none of the metered built-ins (a slow simulator could reach the 500 ms deadline first).
    static func steady(_ c: JSONValue) -> Bool {
        let code = c["expect"]["code"].string
        if let code, !["script_error", "invalid_effect", "invalid_state", "no_handler"].contains(code) { return false }
        let name = c["name"].text
        return !["huge", "sparse", "quadratic", "metered", "repeat past", "accessor length", "refused call", "catastrophic", "deadline", "budget", "memory", "recursion"]
            .contains { name.contains($0) }
    }

    static func cases(_ fixture: JSONValue, where keep: (JSONValue) -> Bool = steady) throws -> [Case] {
        try fixture["runs"].array.filter(keep).map { c in
            var raw = fixture["docs"][c["doc"].text].object
            if let script = c.object["script"] { raw["script"] = script }
            guard let doc = Hypertext.parseDoc(.object(raw)) else { throw Malformed(description: "\(c["name"].text): the card does not parse") }
            let prevValue = c.object["prev"] ?? c["state"]
            guard case .object(let prev) = prevValue else { throw Malformed(description: "\(c["name"].text): no prev state") }
            let request: JSONValue = .object(["doc": .object(raw), "state": c["state"], "prev": prevValue, "handler": c["handler"], "event": c["event"], "viewer": c["viewer"]])
            return Case(name: c["name"].text, raw: .object(raw), doc: doc, prev: prev, request: Hypertext.jsonText(request), expect: c["expect"])
        }
    }

    /// Why a natively checked result does not match the case, nil when it does. A success compares only the fields
    /// the case gives; a failure its code, and its line and logs when given.
    static func mismatch(_ c: Case, _ result: Hypertext.RunResult) -> String? {
        let e = c.expect
        switch result {
        case .failed(let error, let logs):
            guard e["ok"] == .bool(false) else { return "\(c.name): failed with \(error.code.rawValue): \(error.message)" }
            if error.code.rawValue != e["code"].text { return "\(c.name): \(error.code.rawValue) instead of \(e["code"].text) (\(error.message))" }
            if let line = e.object["line"], line != .number(Double(error.line ?? -1)) { return "\(c.name): line \(error.line.map(String.init) ?? "none")" }
            if let expected = e.object["logs"], expected != .array(logs.map(JSONValue.string)) { return "\(c.name): logs \(logs)" }
            return nil
        case .ok(let run):
            guard e["ok"] == .bool(true) else { return "\(c.name): succeeded instead of failing with \(e["code"].text)" }
            for (key, expected) in e.object where key != "ok" {
                let actual: JSONValue
                switch key {
                case "state": actual = .object(run.state)
                case "effects": actual = .array(run.effects.map(\.json))
                case "notices": actual = .array(run.notices.map(JSONValue.string))
                case "logs": actual = .array(run.logs.map(JSONValue.string))
                case "changed": actual = .bool(run.changed)
                case "confirm":
                    // The bundle writes `sheet` only when it is true.
                    actual = run.confirm.map { k in
                        var o: [String: JSONValue] = ["text": .string(k.text), "kind": .string(k.kind.rawValue)]
                        if k.sheet { o["sheet"] = .bool(true) }
                        return .object(o)
                    } ?? .null
                default: return "\(c.name): the case expects an unknown field \(key)"
                }
                if actual != expected { return "\(c.name): \(key) is \(Hypertext.jsonText(actual)), expected \(Hypertext.jsonText(expected))" }
            }
            return nil
        }
    }
}
