import Foundation

/// Interactive messages (messages.kind = "hypertext"), card format v1 (docs/HYPERTEXT.md): the pure logic every client
/// runs natively, a port of frontend/src/hypertext/{types,text,format,bindings,dice,effects}.ts. The shared fixtures
/// mobile/contracts/fixtures/hypertext.json and hypertext-client.json pin it, so change the TypeScript and the fixture
/// first and keep this a line-by-line mirror. Card values stay `JSONValue` (decoded with `JSONDecoder`, which keeps
/// booleans and numbers apart on every platform); numbers are integers within ±1e9 and are written with
/// `String(Int64(d))`. Lengths count code points (`unicodeScalars`). `JSONValue` keeps no key order, so where the web
/// walks keys in document order this walks them sorted; only diagnostic messages can differ.
public enum Hypertext {
    public typealias State = [String: JSONValue]

    // MARK: - Types (types.ts)

    public struct EnumValue: Equatable, Sendable {
        public let value: String
        public let label: String
    }
    public enum StateDecl: Equatable, Sendable {
        case bool
        case int(min: Int, max: Int, default: Int?)
        case enumeration(values: [EnumValue], default: String?)
        case set(values: [EnumValue], max: Int)
        case text(max: Int)
        /// The declaration's `type` as the format spells it.
        public var type: String {
            switch self {
            case .bool: "bool"
            case .int: "int"
            case .enumeration: "enum"
            case .set: "set"
            case .text: "text"
            }
        }
        /// The declared values of an enum or a set ([] otherwise).
        public var values: [EnumValue] {
            switch self {
            case .enumeration(let v, _), .set(let v, _): v
            default: []
            }
        }
    }
    /// Conditions (`show_if`, `enable_if`), typed at post time: depth ≤3, ≤8 leaves.
    public indirect enum Cond: Equatable, Sendable {
        case eq(String, JSONValue), isIn(String, [JSONValue]), has(String, String), gte(String, Int), lte(String, Int), empty(String, Bool)
        case all([Cond]), any([Cond]), not(Cond)
    }
    public enum SayKind: String, Sendable { case ic, ooc }
    /// A button's declarative action, run natively without the engine: set first, then say (from the new state), then
    /// reply.
    public struct Act: Equatable, Sendable {
        public internal(set) var set: State?
        public internal(set) var say: String?
        public internal(set) var sayKind: SayKind?
        public internal(set) var reply: String?
    }
    /// One node of a card. Which fields apply depends on `kind`, as in the format: `text`, `style` and `tone` for text;
    /// `label` (always for checkbox and button), `bind`, `enableIf` and `on` for controls; `display` and `options` for a
    /// choice; `placeholder` and `submitLabel` for an input; `style` and `act` for a button; `title` and `children` for a
    /// group; `children` for a row.
    public struct Node: Equatable, Sendable {
        public enum Kind: String, Sendable { case text, checkbox, choice, input, button, divider, row, group }
        public internal(set) var kind: Kind
        /// The node's place in document order (depth first, a container before its children): the index of its
        /// `Resolved` in `resolve`'s answer and of the node in `Doc.nodes`.
        public internal(set) var index: Int
        public internal(set) var id: String? = nil
        public internal(set) var showIf: Cond? = nil
        public internal(set) var enableIf: Cond? = nil
        public internal(set) var on: String? = nil
        public internal(set) var text: String = ""
        /// Text: body, muted, heading or strong. Button: primary, secondary or danger.
        public internal(set) var style: String = ""
        /// Text: neutral, good, bad or warn.
        public internal(set) var tone: String = ""
        public internal(set) var label: String? = nil
        public internal(set) var bind: String? = nil
        /// Choice: list, buttons or menu.
        public internal(set) var display: String = ""
        public internal(set) var options: [String]? = nil
        public internal(set) var placeholder: String? = nil
        public internal(set) var submitLabel: String? = nil
        public internal(set) var act: Act? = nil
        public internal(set) var title: String? = nil
        public internal(set) var children: [Node] = []
        public var isControl: Bool { [.checkbox, .choice, .input, .button].contains(kind) }
        /// A button whose act posts a line (says or replies): it needs a run left.
        public var postsSomething: Bool { kind == .button && (act?.say != nil || act?.reply != nil) }
    }
    /// Public stub of a private reply template: the text, kind, character and limits never leave the server.
    public enum SlotDecl: Equatable, Sendable { case int(min: Int, max: Int), enumeration([String]) }
    public struct ReplyStub: Equatable, Sendable {
        public let id: String
        public let slots: [String: SlotDecl]
        /// card, viewer or gm.
        public let audience: String
        public let group: String?
    }
    public struct Doc: Equatable, Sendable {
        public let title: String
        public let state: [String: StateDecl]
        /// The declared keys, sorted (the order every loop over the declarations uses).
        public let keys: [String]
        public let body: [Node]
        /// Every node in document order (`Node.index`).
        public let nodes: [Node]
        public let script: String?
        public let actors: [String]?
        public let runsPerViewer: Int
        public let closesAt: String?
        public let replies: [ReplyStub]
    }

    /// Why every control is disabled; nil when the viewer may act.
    public enum LockReason: String, Sendable { case closed, recalled, notActor = "not_actor", spectator, history, archived, paused, loading }
    public struct ResolvedOption: Equatable, Sendable {
        public let value: String
        public let label: String
        public let selected: Bool
        public let disabled: Bool
    }
    /// One node as drawn, in document order (containers before their children).
    public struct Resolved: Equatable, Sendable {
        public let node: Node
        /// A text node, interpolated.
        public internal(set) var text: String? = nil
        /// A control's label or a group's title, interpolated.
        public internal(set) var label: String? = nil
        /// A button's declarative say, as it would be posted.
        public internal(set) var caption: String? = nil
        /// The bound state value; nil when the state has no such key.
        public internal(set) var value: JSONValue? = nil
        /// A choice's options, in display order.
        public internal(set) var options: [ResolvedOption]? = nil
        public internal(set) var visible: Bool
        public internal(set) var disabled: Bool
    }

    /// UI actions on a control. Toggle: a checkbox. Select: a choice option (an enum selects, a set toggles). Submit: an
    /// input (fires its handler). Commit: an input's draft written on blur, which fires no handler. Click: a button.
    public enum Action: Equatable, Sendable { case toggle, select(String), submit(String), commit(String), click }
    public enum EventType: String, Sendable { case change, submit, click }
    public struct Event: Equatable, Sendable {
        public let type: EventType
        public let node: String
        public let value: JSONValue
        public var json: JSONValue { .object(["type": .string(type.rawValue), "node": .string(node), "value": value]) }
    }
    /// What an action gives: the new state, and the event its `on` handler gets (nil for a commit).
    public struct Applied: Equatable, Sendable {
        public let state: State
        public let event: Event?
    }
    public enum Effect: Equatable, Sendable {
        case say(text: String, kind: SayKind)
        case reply(id: String, slots: [String: JSONValue])
        public var json: JSONValue {
            switch self {
            case .say(let text, let kind): .object(["type": .string("say"), "text": .string(text), "kind": .string(kind.rawValue)])
            case .reply(let id, let slots): .object(["type": .string("reply"), "id": .string(id), "slots": .object(slots)])
            }
        }
    }
    /// A declarative act's outcome: the new state and the effects to send.
    public struct ActOutcome: Equatable, Sendable {
        public let state: State
        public let effects: [Effect]
    }

    /// The viewer as a script sees them: no ids, no token.
    public struct Viewer: Equatable, Sendable {
        public let gm: Bool
        public let actor: Bool
        public let character: String?
        public init(gm: Bool, actor: Bool, character: String?) { self.gm = gm; self.actor = actor; self.character = character }
        public var json: JSONValue { .object(["gm": .bool(gm), "actor": .bool(actor), "character": character.map(JSONValue.string) ?? .null]) }
    }
    public enum ErrorCode: String, Sendable, CaseIterable {
        case scriptError = "script_error", noHandler = "no_handler", budget, memory, stack, timeout
        case invalidState = "invalid_state", invalidEffect = "invalid_effect", engineUnavailable = "engine_unavailable", engine
    }
    public struct EngineError: Error, Equatable, Sendable {
        public let code: ErrorCode
        public let message: String
        public let line: Int?
    }
    /// What a free-text say needs before it is sent: the viewer's confirmation (`sheet`: the command changes their sheet).
    public struct Confirm: Equatable, Sendable {
        public let text: String
        public let kind: SayKind
        public let sheet: Bool
        public init(text: String, kind: SayKind, sheet: Bool = false) { self.text = text; self.kind = kind; self.sheet = sheet }
    }
    public struct Run: Equatable, Sendable {
        public let state: State
        public let effects: [Effect]
        public let notices: [String]
        public let logs: [String]
        public let confirm: Confirm?
        /// Whether the state differs from the one shown before the action (no effects and no change: nothing to save).
        public let changed: Bool
    }
    public enum RunResult: Equatable, Sendable {
        case ok(Run)
        case failed(EngineError, logs: [String])
    }
    /// A refused value or effect, with the message a GM sees.
    public struct Invalid: Error, Equatable, Sendable { public let message: String }

    // MARK: - Text rules (text.ts)

    /// Length in code points.
    public static func cpLength(_ s: String) -> Int { s.unicodeScalars.count }
    public static func cpPrefix(_ s: String, _ n: Int) -> String {
        let scalars = s.unicodeScalars
        return scalars.count <= n ? s : String(String.UnicodeScalarView(scalars.prefix(n)))
    }
    /// UTF-8 byte length (a Swift string holds no lone surrogates).
    public static func utf8Bytes(_ s: String) -> Int { s.utf8.count }
    /// Refused: C0 controls (except \n where the text is multi-line), bidi embeddings, overrides and isolates
    /// (U+202A–202E, U+2066–2069) and noncharacters.
    static func refused(_ u: Unicode.Scalar, multiline: Bool) -> Bool {
        let c = u.value
        if c < 0x20 { return !(c == 0x0a && multiline) }
        if (0x202a...0x202e).contains(c) || (0x2066...0x2069).contains(c) { return true }
        return (0xfdd0...0xfdef).contains(c) || c & 0xfffe == 0xfffe
    }
    public static func textOk(_ s: String, multiline: Bool = false) -> Bool { !s.unicodeScalars.contains { refused($0, multiline: multiline) } }
    /// An allowed string of `min` to `max` code points.
    public static func boundedText(_ s: String, _ max: Int, multiline: Bool = false, min: Int = 0) -> Bool {
        let n = cpLength(s)
        return n >= min && n <= max && textOk(s, multiline: multiline)
    }
    static func boundedText(_ v: JSONValue?, _ max: Int, multiline: Bool = false, min: Int = 0) -> Bool {
        if case .string(let s)? = v { return boundedText(s, max, multiline: multiline, min: min) }
        return false
    }
    /// Refused characters become U+FFFD: for diagnostics (logs, error messages) that are shown, never sent.
    public static func sanitize(_ s: String, multiline: Bool = true) -> String {
        var out = String.UnicodeScalarView()
        for u in s.unicodeScalars { out.append(refused(u, multiline: multiline) ? "\u{FFFD}" : u) }
        return String(out)
    }
    /// Lines as a reader sees them: \n, and the breaks the text rules let through (U+0085, U+2028, U+2029).
    public static func lineCount(_ s: String) -> Int { 1 + s.unicodeScalars.filter { [0x0a, 0x85, 0x2028, 0x2029].contains($0.value) }.count }
    /// Nesting depth of a JSON text, scanned before it is parsed so a deep document cannot exhaust the parser's stack.
    public static func jsonDepth(_ raw: String) -> Int {
        var depth = 0, top = 0, inString = false, skip = false
        for c in raw.utf8 {
            if inString {
                if skip { skip = false } else if c == 0x5c { skip = true } else if c == 0x22 { inString = false }
                continue
            }
            if c == 0x22 { inString = true }
            else if c == 0x5b || c == 0x7b { depth += 1; top = Swift.max(top, depth) }
            else if c == 0x5d || c == 0x7d { depth -= 1 }
        }
        return top
    }
    /// Trim as the server does (C++ text::trim: ASCII whitespace only, so a full-width space is kept).
    public static func asciiTrim(_ s: String) -> String {
        let u = Array(s.unicodeScalars)
        let ws: (Unicode.Scalar) -> Bool = { $0.value == 0x20 || (0x09...0x0d).contains($0.value) }
        var a = 0, b = u.count
        while a < b && ws(u[a]) { a += 1 }
        while b > a && ws(u[b - 1]) { b -= 1 }
        return a == 0 && b == u.count ? s : String(String.UnicodeScalarView(u[a..<b]))
    }
    /// Ids, state keys and handler names: ^[a-z][a-z0-9_]{0,31}$, never a JS prototype name (the server's kReserved;
    /// the names that start with "_" already fail the pattern).
    private static let reserved: Set<String> = ["constructor", "prototype", "hasownproperty", "isprototypeof", "propertyisenumerable", "tolocalestring", "tostring", "valueof"]
    public static func isId(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard (1...32).contains(b.count), (0x61...0x7a).contains(b[0]) else { return false }
        return b.allSatisfy { (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x5f } && !reserved.contains(s)
    }
    static func isId(_ v: JSONValue?) -> Bool { if case .string(let s)? = v { return isId(s) }; return false }

    /// JSON text as JavaScript's JSON.stringify writes it (for sizes, comparisons and request bodies): an integral
    /// number without a fraction, the same string escapes; object keys sorted.
    public static func jsonText(_ v: JSONValue) -> String {
        var out = ""
        write(v, into: &out)
        return out
    }
    private static func write(_ v: JSONValue, into out: inout String) {
        switch v {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let d): out += numberText(d)
        case .string(let s): quote(s, into: &out)
        case .array(let a):
            out += "["
            for (i, x) in a.enumerated() { if i > 0 { out += "," }; write(x, into: &out) }
            out += "]"
        case .object(let o):
            out += "{"
            for (i, k) in o.keys.sorted(by: utf16Order).enumerated() {
                if i > 0 { out += "," }
                quote(k, into: &out); out += ":"; write(o[k]!, into: &out)
            }
            out += "}"
        }
    }
    private static func quote(_ s: String, into out: inout String) {
        var u = String.UnicodeScalarView()
        u.append("\"")
        for c in s.unicodeScalars {
            switch c.value {
            case 0x22: u.append(contentsOf: "\\\"".unicodeScalars)
            case 0x5c: u.append(contentsOf: "\\\\".unicodeScalars)
            case 0x08: u.append(contentsOf: "\\b".unicodeScalars)
            case 0x09: u.append(contentsOf: "\\t".unicodeScalars)
            case 0x0a: u.append(contentsOf: "\\n".unicodeScalars)
            case 0x0c: u.append(contentsOf: "\\f".unicodeScalars)
            case 0x0d: u.append(contentsOf: "\\r".unicodeScalars)
            case 0..<0x20:
                let hex = String(c.value, radix: 16)
                u.append(contentsOf: ("\\u" + String(repeating: "0", count: 4 - hex.count) + hex).unicodeScalars)
            default: u.append(c)
            }
        }
        u.append("\"")
        out += String(u)
    }
    /// A number as JavaScript writes it, for the integers a card holds (-0 is "0").
    static func numberText(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == d.rounded(.towardZero) && abs(d) < 9e18 { return String(Int64(d)) }
        return "\(d)"
    }
    /// JavaScript's default sort order (UTF-16 code units), as `Object.keys(…).sort()`.
    static func utf16Order(_ a: String, _ b: String) -> Bool { a.utf16.lexicographicallyPrecedes(b.utf16) }
    /// Card text compares code unit by code unit, as on the web, the server and Android. Swift's == on String (and so
    /// on JSONValue and in a Set<String>) treats canonically equivalent text as equal ("\u{E9}" and "e\u{301}"), which
    /// would give another answer than theirs for the same card.
    public static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
    /// JSON values by the same rule: strings by code unit, numbers, booleans and null as they are.
    public static func same(_ a: JSONValue?, _ b: JSONValue?) -> Bool {
        switch (a, b) {
        case (.string(let x)?, .string(let y)?): return same(x, y)
        case (.array(let x)?, .array(let y)?): return x.count == y.count && zip(x, y).allSatisfy { same($0, $1) }
        case (.object(let x)?, .object(let y)?):
            return x.count == y.count && x.allSatisfy { k, v in y.contains { same($0.key, k) && same($0.value, v) } }
        default: return a == b
        }
    }
    /// Whether no two strings are the same code units.
    static func distinct(_ list: [String]) -> Bool { Set(list.map { Array($0.utf16) }).count == list.count }
    /// Whether `list` holds the string `s` (a set's value), by code unit.
    static func holds(_ list: [JSONValue], _ s: String) -> Bool { list.contains { same($0, .string(s)) } }
    static func holds(_ values: [EnumValue], _ s: String) -> Bool { values.contains { same($0.value, s) } }

    // MARK: - Reading a card (format.ts)

    // Tolerant reading of a stored card (messages.hypertext). The server is the validator: it accepts only v1 and refuses
    // unknown keys. A client only needs to know whether it can draw and run the card safely, so parseDoc returns a fresh,
    // normalized copy (known fields only) or nil for an unknown `v` or anything malformed; the message then shows its
    // plain-text `content`. Every reference is checked here (binds, act keys, reply ids, condition types), so the rest
    // can trust the shape. It fills in what the server's normalize fills in: title "", a value's label = its value, text
    // style body and tone neutral, choice display list, button style primary, enum default null, script, actors and
    // closes_at null, runs_per_viewer 1, replies [], a stub's slots {}, audience card and group null; act.say is kept
    // ASCII-trimmed, as it is posted.
    public enum Limits {
        public static let title = 120, stateKeys = 32, enumValues = 20, valueLen = 64, labelLen = 120, setMax = 20, textMax = 500
        public static let int = 1_000_000_000.0
        public static let nodes = 64, text = 2000, label = 120, buttonLabel = 60, submitLabel = 40, groupTitle = 80, script = 16384
        public static let actors = 10, runs = 100, replies = 16, slots = 4, condDepth = 3, condLeaves = 8, say = 500, stateBytes = 8192
    }

    private struct Malformed: Error {}
    private static func need(_ ok: Bool) throws { if !ok { throw Malformed() } }
    private static func object(_ v: JSONValue?) -> [String: JSONValue]? { if case .object(let o)? = v { return o }; return nil }
    /// An integer (1.0 counts) within ±`limit`.
    static func integer(_ v: JSONValue?, limit: Double = Limits.int) -> Int? {
        guard case .number(let d)? = v, d.isFinite, d == d.rounded(.towardZero), abs(d) <= limit else { return nil }
        return Int(d)
    }
    /// JavaScript's Number.isInteger.
    private static func integral(_ v: JSONValue?) -> Double? {
        guard case .number(let d)? = v, d.isFinite, d == d.rounded(.towardZero) else { return nil }
        return d
    }
    private static func optText(_ v: JSONValue?, _ max: Int) -> Bool { v == nil || boundedText(v, max) }
    private static func pick(_ v: JSONValue?, _ allowed: [String], _ fallback: String) throws -> String {
        guard let v else { return fallback }
        guard case .string(let s) = v, allowed.contains(s) else { throw Malformed() }
        return s
    }

    private static func enumValues(_ v: JSONValue?) throws -> [EnumValue] {
        guard case .array(let list)? = v, (2...Limits.enumValues).contains(list.count) else { throw Malformed() }
        var seen = Set<[UInt16]>()
        return try list.map { x in
            guard let o = object(x), boundedText(o["value"], Limits.valueLen, min: 1), case .string(let value)? = o["value"],
                  o["label"] == nil || boundedText(o["label"], Limits.labelLen), seen.insert(Array(value.utf16)).inserted else { throw Malformed() }
            return EnumValue(value: value, label: o["label"]?.string ?? value)
        }
    }
    private static func stateDecl(_ v: JSONValue?) throws -> StateDecl {
        guard let d = object(v) else { throw Malformed() }
        switch d["type"] {
        case .string("bool")?: return .bool
        case .string("int")?:
            guard let lo = integer(d["min"]), let hi = integer(d["max"]), lo <= hi else { throw Malformed() }
            guard d["default"] != nil else { return .int(min: lo, max: hi, default: nil) }
            guard let def = integer(d["default"]), def >= lo, def <= hi else { throw Malformed() }
            return .int(min: lo, max: hi, default: def)
        case .string("enum")?:
            let values = try enumValues(d["values"])
            guard let def = d["default"], def != .null else { return .enumeration(values: values, default: nil) }
            guard case .string(let s) = def, holds(values, s) else { throw Malformed() }
            return .enumeration(values: values, default: s)
        case .string("set")?:
            let values = try enumValues(d["values"])
            guard let max = integer(d["max"]), (1...Limits.setMax).contains(max) else { throw Malformed() }
            return .set(values: values, max: max)
        case .string("text")?:
            guard let max = integer(d["max"]), (1...Limits.textMax).contains(max) else { throw Malformed() }
            return .text(max: max)
        default: throw Malformed()
        }
    }

    /// Whether a value fits a reply slot: a declared enum string, or an integer within the slot's range.
    public static func slotOk(_ d: SlotDecl, _ v: JSONValue?) -> Bool {
        switch d {
        case .enumeration(let values): if case .string(let s)? = v { return values.contains { same($0, s) } }; return false
        case .int(let lo, let hi): if let x = integral(v) { return x >= Double(lo) && x <= Double(hi) }; return false
        }
    }
    /// Whether a value is valid for a declaration (also the check of validateState, per key).
    public static func validValue(_ d: StateDecl, _ v: JSONValue?) -> Bool {
        switch d {
        case .bool: if case .bool? = v { return true }; return false
        case .int(let lo, let hi, _): if let x = integral(v) { return x >= Double(lo) && x <= Double(hi) }; return false
        case .enumeration(let values, _):
            if v == .null { return true }
            if case .string(let s)? = v { return holds(values, s) }
            return false
        case .set(let values, let max):
            guard case .array(let a)? = v, a.count <= max else { return false }
            let strings = a.compactMap(\.string)
            return strings.count == a.count && distinct(strings) && strings.allSatisfy { holds(values, $0) }
        case .text(let max): return boundedText(v, max)
        }
    }

    private typealias Decls = [String: StateDecl]
    private static func declOf(_ decls: Decls, _ key: JSONValue?) throws -> StateDecl {
        guard case .string(let k)? = key, isId(k), let d = decls[k] else { throw Malformed() }
        return d
    }
    private static func declOf(_ decls: Decls, _ key: String) throws -> StateDecl { try declOf(decls, .string(key)) }
    private static func isValue(_ d: StateDecl, _ v: JSONValue) -> Bool {
        switch d {
        case .enumeration(let values, _): if case .string(let s) = v { return holds(values, s) }; return false
        case .int: return integer(v) != nil
        default: return false
        }
    }

    private final class Leaves { var n = 0 }
    private static func cond(_ v: JSONValue?, _ decls: Decls, depth: Int, _ leaves: Leaves) throws -> Cond {
        guard let c = object(v), depth <= Limits.condDepth else { throw Malformed() }
        func list(_ x: JSONValue?) throws -> [Cond] {
            guard case .array(let a)? = x, a.count >= 1 else { throw Malformed() }
            return try a.map { try cond($0, decls, depth: depth + 1, leaves) }
        }
        if c["all"] != nil { try need(c.count == 1); return .all(try list(c["all"])) }
        if c["any"] != nil { try need(c.count == 1); return .any(try list(c["any"])) }
        if c["not"] != nil { try need(c.count == 1); return .not(try cond(c["not"], decls, depth: depth + 1, leaves)) }
        leaves.n += 1
        try need(leaves.n <= Limits.condLeaves)
        let ops = c.keys.filter { $0 != "key" }
        try need(ops.count == 1)
        let d = try declOf(decls, c["key"])
        let key = c["key"]!.text, op = ops[0], x = c[op]!
        switch op {
        case "eq":
            let ok: Bool
            switch d {
            case .bool: if case .bool = x { ok = true } else { ok = false }
            case .int: ok = integer(x) != nil
            case .enumeration: ok = x == .null || isValue(d, x)
            case .text(let max): ok = boundedText(x, max)
            case .set: ok = false
            }
            try need(ok)
            return .eq(key, x)
        case "in":
            guard case .array(let a) = x else { throw Malformed() }
            switch d { case .int, .enumeration: break; default: throw Malformed() }
            try need((1...Limits.enumValues).contains(a.count) && a.allSatisfy { isValue(d, $0) })
            return .isIn(key, a)
        case "has":
            guard case .set(let values, _) = d, case .string(let s) = x, holds(values, s) else { throw Malformed() }
            return .has(key, s)
        case "gte", "lte":
            guard case .int = d, let n = integer(x) else { throw Malformed() }
            return op == "gte" ? .gte(key, n) : .lte(key, n)
        case "empty":
            guard case .bool(let b) = x else { throw Malformed() }
            switch d { case .text, .set, .enumeration: return .empty(key, b); default: throw Malformed() }
        default: throw Malformed()
        }
    }

    private static func slotDecl(_ v: JSONValue?) throws -> SlotDecl {
        guard let s = object(v) else { throw Malformed() }
        if s["type"] == .string("int") {
            guard let lo = integer(s["min"]), let hi = integer(s["max"]), lo <= hi else { throw Malformed() }
            return .int(min: lo, max: hi)
        }
        guard s["type"] == .string("enum"), case .array(let a)? = s["values"], (1...Limits.enumValues).contains(a.count),
              a.allSatisfy({ boundedText($0, Limits.valueLen, min: 1) }) else { throw Malformed() }
        return .enumeration(a.map(\.text))
    }
    private static func replyStub(_ v: JSONValue) throws -> ReplyStub {
        guard let r = object(v), isId(r["id"]), r["slots"] == nil || object(r["slots"]) != nil else { throw Malformed() }
        let raw = object(r["slots"]) ?? [:]
        try need(raw.count <= Limits.slots)
        var slots: [String: SlotDecl] = [:]
        for (k, s) in raw { try need(isId(k)); slots[k] = try slotDecl(s) }
        try need(r["group"] == nil || r["group"] == .null || isId(r["group"]))
        return ReplyStub(id: r["id"]!.text, slots: slots, audience: try pick(r["audience"], ["card", "viewer", "gm"], "card"), group: r["group"]?.string)
    }

    private static func act(_ v: JSONValue?, _ decls: Decls, _ replies: [ReplyStub]) throws -> Act {
        guard let a = object(v) else { throw Malformed() }
        var out = Act()
        if let raw = a["set"] {
            guard let set = object(raw) else { throw Malformed() }
            var values: State = [:]
            for (k, x) in set { try need(validValue(try declOf(decls, k), x)); values[k] = x }
            out.set = values
        }
        // Checked and kept as posted: ASCII-trimmed, as the server checks it (sayError) and the say is posted.
        if let say = a["say"] {
            guard case .string(let s) = say, boundedText(asciiTrim(s), Limits.say, multiline: true, min: 1) else { throw Malformed() }
            out.say = asciiTrim(s)
        }
        if let kind = a["say_kind"] { try need(a["say"] != nil); out.sayKind = SayKind(rawValue: try pick(kind, ["ic", "ooc"], "ic")) }
        if let reply = a["reply"] {
            guard let stub = replies.first(where: { JSONValue.string($0.id) == reply }) else { throw Malformed() }
            // Each slot is filled from the state key of the same name.
            for (k, s) in stub.slots {
                let d = try declOf(decls, k)
                switch (s, d) { case (.int, .int), (.enumeration, .enumeration): break; default: throw Malformed() }
            }
            out.reply = stub.id
        }
        try need(out.set != nil || out.say != nil || out.reply != nil)
        return out
    }

    private final class Reader {
        let decls: Decls, replies: [ReplyStub]
        var ids = Set<String>(), count = 0
        init(_ decls: Decls, _ replies: [ReplyStub]) { self.decls = decls; self.replies = replies }
    }
    private static func node(_ v: JSONValue, _ rd: Reader, level: Int) throws -> Node {
        guard let n = object(v) else { throw Malformed() }
        rd.count += 1
        try need(rd.count <= Limits.nodes)
        var node = Node(kind: .divider, index: rd.count - 1)
        if let id = n["id"] {
            guard case .string(let s) = id, isId(s), !rd.ids.contains(s) else { throw Malformed() }
            rd.ids.insert(s); node.id = s
        }
        if let c = n["show_if"] { node.showIf = try cond(c, rd.decls, depth: 1, Leaves()) }
        func control() throws {
            try need(node.id != nil)
            if let c = n["enable_if"] { node.enableIf = try cond(c, rd.decls, depth: 1, Leaves()) }
            if let on = n["on"] { try need(isId(on)); node.on = on.text }
        }
        func bound(_ types: [String]) throws -> StateDecl {
            let d = try declOf(rd.decls, n["bind"])
            try need(types.contains(d.type))
            node.bind = n["bind"]!.text
            return d
        }
        func children(_ lv: Int) throws -> [Node] {
            guard case .array(let a)? = n["children"] else { throw Malformed() }
            return try a.map { try Self.node($0, rd, level: lv) }
        }
        switch n["type"] {
        case .string("text")?:
            try need(boundedText(n["text"], Limits.text, multiline: true))
            node.kind = .text; node.text = n["text"]!.text
            node.style = try pick(n["style"], ["body", "muted", "heading", "strong"], "body")
            node.tone = try pick(n["tone"], ["neutral", "good", "bad", "warn"], "neutral")
        case .string("divider")?: node.kind = .divider
        case .string("checkbox")?:
            try control(); _ = try bound(["bool"])
            try need(boundedText(n["label"], Limits.label))
            node.kind = .checkbox; node.label = n["label"]!.text
        case .string("choice")?:
            try control()
            let d = try bound(["enum", "set"])
            try need(optText(n["label"], Limits.label))
            node.kind = .choice; node.label = n["label"]?.string
            node.display = try pick(n["display"], ["list", "buttons", "menu"], "list")
            if let raw = n["options"] {
                guard case .array(let a) = raw else { throw Malformed() }
                let options = a.compactMap(\.string)
                try need(a.count >= 1 && options.count == a.count && distinct(options) && options.allSatisfy { holds(d.values, $0) })
                node.options = options
            }
        case .string("input")?:
            try control(); _ = try bound(["text"])
            try need(optText(n["label"], Limits.label) && optText(n["placeholder"], Limits.label) && optText(n["submit_label"], Limits.submitLabel))
            node.kind = .input; node.label = n["label"]?.string; node.placeholder = n["placeholder"]?.string; node.submitLabel = n["submit_label"]?.string
        case .string("button")?:
            try control()
            try need(boundedText(n["label"], Limits.buttonLabel) && (node.on == nil) != (n["act"] == nil))
            node.kind = .button; node.label = n["label"]!.text
            node.style = try pick(n["style"], ["primary", "secondary", "danger"], "primary")
            if let a = n["act"] { node.act = try act(a, rd.decls, rd.replies) }
        case .string("row")?:
            try need(level < 2)
            node.kind = .row; node.children = try children(2)
        case .string("group")?:
            try need(level == 0 && optText(n["title"], Limits.groupTitle))
            node.kind = .group; node.title = n["title"]?.string; node.children = try children(1)
        default: throw Malformed()
        }
        return node
    }

    /// The card of a message (its `hypertext`), or nil for an unknown `v` or anything malformed: the message then shows
    /// its `content` with "Update the app to use this message.". It never throws.
    public static func parseDoc(_ raw: JSONValue?) -> Doc? { try? read(raw) }
    private static func read(_ raw: JSONValue?) throws -> Doc {
        guard let r = object(raw) else { throw Malformed() }
        try need(r["v"] == .number(1) && (r["title"] == nil || boundedText(r["title"], Limits.title)))
        try need(r["state"] == nil || object(r["state"]) != nil)
        let declared = object(r["state"]) ?? [:]
        try need(declared.count <= Limits.stateKeys)
        var decls: Decls = [:]
        for (k, d) in declared { try need(isId(k)); decls[k] = try stateDecl(d) }
        var replies: [ReplyStub] = []
        if let raw = r["replies"] {
            guard case .array(let a) = raw, a.count <= Limits.replies else { throw Malformed() }
            replies = try a.map(replyStub)
        }
        try need(Set(replies.map(\.id)).count == replies.count)
        guard case .array(let rawBody)? = r["body"], rawBody.count >= 1 else { throw Malformed() }
        let reader = Reader(decls, replies)
        let body = try rawBody.map { try node($0, reader, level: 0) }
        let script = r["script"]
        try need(script == nil || script == .null || (script?.string).map { utf8Bytes($0) <= Limits.script } == true)
        var actors: [String]? = nil
        if let raw = r["actors"], raw != .null {
            guard case .array(let a) = raw, a.count <= Limits.actors, a.allSatisfy({ $0.string != nil }) else { throw Malformed() }
            actors = a.map(\.text)
        }
        let runs = r["runs_per_viewer"]
        try need(runs == nil || integer(runs).map { (1...Limits.runs).contains($0) } == true)
        let closes = r["closes_at"]
        try need(closes == nil || closes == .null || closes?.string != nil)
        var nodes: [Node] = []
        func flatten(_ list: [Node]) { for n in list { nodes.append(n); flatten(n.children) } }
        flatten(body)
        let source = script?.string ?? ""
        return Doc(title: r["title"]?.string ?? "", state: decls, keys: decls.keys.sorted(by: utf16Order), body: body, nodes: nodes,
                   script: source.isEmpty ? nil : source, actors: actors,
                   runsPerViewer: integer(runs) ?? 1, closesAt: closes?.string, replies: replies)
    }

    /// The first node with this id, in document order.
    public static func findNode(_ doc: Doc, _ id: String) -> Node? { doc.nodes.first { $0.id == id } }
    /// Whether any control runs a script handler (only such cards ever start the engine).
    public static func scripted(_ doc: Doc) -> Bool { doc.script != nil && doc.nodes.contains { $0.on != nil } }

    // MARK: - Bindings (bindings.ts)

    public static func defaultOf(_ d: StateDecl) -> JSONValue {
        switch d {
        case .bool: .bool(false)
        case .int(let lo, _, let def): .number(Double(def ?? lo))
        case .enumeration(_, let def): def.map(JSONValue.string) ?? .null
        case .set: .array([])
        case .text: .string("")
        }
    }
    public static func defaultState(_ doc: Doc) -> State { doc.state.mapValues(defaultOf) }
    /// A stored state laid over the defaults: undeclared keys are dropped, a bad value falls back to its default.
    public static func overlay(_ doc: Doc, _ stored: JSONValue?) -> State {
        var s = defaultState(doc)
        guard case .object(let o)? = stored else { return s }
        for (k, d) in doc.state { if let v = o[k], validValue(d, v) { s[k] = v } }
        return s
    }
    public static func overlay(_ doc: Doc, state stored: State?) -> State { overlay(doc, stored.map(JSONValue.object)) }

    public enum StateCheck: Equatable, Sendable {
        case ok(State)
        /// `key`: the offending key, the first in sorted order as on the server ("" for the whole state).
        case invalid(key: String, error: String)
    }
    /// A state as the server's validateState reads it (PUT /hypertext/state, /act): only declared keys, each a valid
    /// value; a missing key takes its default. The answer is the completed state (sets in schema order), at most 8 KiB
    /// serialized. The engine's own output must be complete as well (validateOutput).
    public static func validateState(_ doc: Doc, _ state: JSONValue?) -> StateCheck {
        guard case .object(let given)? = state else { return .invalid(key: "", error: "state must be an object") }
        var full = defaultState(doc)
        for k in given.keys.sorted(by: utf16Order) {
            guard let d = doc.state[k] else {
                return .invalid(key: k, error: "state.\(String(decoding: Array(k.utf16.prefix(40)), as: UTF16.self)): not declared")
            }
            let v = given[k]!
            guard validValue(d, v) else { return .invalid(key: k, error: "state.\(k): not a valid \(d.type)") }
            if case .set(let values, _) = d { full[k] = .array(values.map(\.value).filter { holds(v.array, $0) }.map(JSONValue.string)) }
            else { full[k] = v }
        }
        if utf8Bytes(jsonText(.object(full))) > Limits.stateBytes { return .invalid(key: "", error: "state is larger than 8 KiB") }
        return .ok(full)
    }
    public static func validateState(_ doc: Doc, _ state: State) -> StateCheck { validateState(doc, .object(state)) }

    /// A key's value for conditions and interpolation: the state's when it is valid, else the default (C++ valueOf).
    private static func valueAt(_ doc: Doc, _ state: State, _ key: String) -> JSONValue {
        let d = doc.state[key]!
        if let v = state[key], validValue(d, v) { return v }
        return defaultOf(d)
    }
    /// JavaScript's === on card values: lists are never equal (they are compared by reference there).
    private static func strictEqual(_ a: JSONValue, _ b: JSONValue) -> Bool {
        switch (a, b) {
        case (.array, _), (_, .array), (.object, _), (_, .object): false
        default: same(a, b)
        }
    }

    public static func evalCondition(_ c: Cond, _ doc: Doc, _ state: State) -> Bool {
        switch c {
        case .all(let list): return list.allSatisfy { evalCondition($0, doc, state) }
        case .any(let list): return list.contains { evalCondition($0, doc, state) }
        case .not(let inner): return !evalCondition(inner, doc, state)
        case .eq(let key, let x):
            guard doc.state[key] != nil else { return false }
            return strictEqual(valueAt(doc, state, key), x)
        case .isIn(let key, let list):
            guard doc.state[key] != nil else { return false }
            let v = valueAt(doc, state, key)
            return list.contains { strictEqual(v, $0) }
        case .has(let key, let x):
            guard doc.state[key] != nil else { return false }
            return holds(valueAt(doc, state, key).array, x)
        case .gte(let key, let x):
            guard doc.state[key] != nil, case .number(let v) = valueAt(doc, state, key) else { return false }
            return v >= Double(x)
        case .lte(let key, let x):
            guard doc.state[key] != nil, case .number(let v) = valueAt(doc, state, key) else { return false }
            return v <= Double(x)
        case .empty(let key, let x):
            guard let d = doc.state[key] else { return false }
            let v = valueAt(doc, state, key), empty: Bool
            switch d {
            case .text: empty = v == .string("")
            case .set: if case .array(let a) = v { empty = a.isEmpty } else { empty = false }
            case .enumeration: empty = v == .null
            default: empty = false
            }
            return empty == x
        }
    }

    private static func keyChar(_ u: Unicode.Scalar) -> Bool { (0x61...0x7a).contains(u.value) || (0x30...0x39).contains(u.value) || u.value == 0x5f }
    /// `{{key}}`: an enum's label ("" when null), a set's labels in schema order joined with ", ", an int in decimal, a
    /// text as is. A bool or an unknown key is a post-time error, so it is left as written. The same scan as the
    /// server's interpolate: each "{{" either starts a declared key followed by "}}" or is kept, and the scan resumes
    /// after it.
    public static func interpolate(_ text: String, _ doc: Doc, _ state: State) -> String {
        let u = Array(text.unicodeScalars)
        var out = String.UnicodeScalarView(), start = 0
        func open(from: Int) -> Int? {
            var i = from
            while i + 1 < u.count { if u[i] == "{" && u[i + 1] == "{" { return i }; i += 1 }
            return nil
        }
        while let i = open(from: start) {
            out.append(contentsOf: u[start..<i])
            var j = i + 2
            while j < u.count && keyChar(u[j]) { j += 1 }
            let key = String(String.UnicodeScalarView(u[(i + 2)..<j]))
            let closed = j + 1 < u.count && u[j] == "}" && u[j + 1] == "}"
            guard j > i + 2, closed, let d = doc.state[key], d != .bool else {
                out.append(contentsOf: "{{".unicodeScalars); start = i + 2; continue
            }
            let v = valueAt(doc, state, key), piece: String
            switch d {
            case .enumeration(let values, _): piece = values.first { same(.string($0.value), v) }?.label ?? ""
            case .set(let values, _): piece = values.filter { holds(v.array, $0.value) }.map(\.label).joined(separator: ", ")
            case .int: if case .number(let n) = v { piece = numberText(n) } else { piece = "" }
            default: piece = v.text
            }
            out.append(contentsOf: piece.unicodeScalars)
            start = j + 2
        }
        out.append(contentsOf: u[start...])
        return String(out)
    }

    private static func optionsOf(_ doc: Doc, _ n: Node) -> [EnumValue] {
        let values = doc.state[n.bind!]!.values
        guard let options = n.options else { return values }
        return options.compactMap { o in values.first { same($0.value, o) } }
    }

    /// Every node as drawn, in document order. Any lock disables every control; show_if hides (with the node's children),
    /// enable_if disables; a set's unselected options are disabled once it holds `max` values; a button whose act
    /// replies is disabled while a slot cannot be filled from the state (a null enum, or a value the slot does not list).
    public static func resolve(_ doc: Doc, _ state: State, _ lock: LockReason?) -> [Resolved] {
        var out: [Resolved] = []
        let locked = lock != nil
        func visit(_ nodes: [Node], _ shown: Bool) {
            for n in nodes {
                let visible = shown && (n.showIf.map { evalCondition($0, doc, state) } ?? true)
                var r = Resolved(node: n, visible: visible, disabled: false)
                if n.isControl { r.disabled = locked || (n.enableIf.map { !evalCondition($0, doc, state) } ?? false) }
                switch n.kind {
                case .text: r.text = interpolate(n.text, doc, state)
                case .group: r.label = n.title.map { interpolate($0, doc, state) }
                case .checkbox: r.label = interpolate(n.label ?? "", doc, state); r.value = state[n.bind!]
                case .input: r.label = n.label.map { interpolate($0, doc, state) }; r.value = state[n.bind!]
                case .choice:
                    r.label = n.label.map { interpolate($0, doc, state) }
                    let v = state[n.bind!]
                    var full = false
                    if case .set(_, let max) = doc.state[n.bind!]!, case .array(let a)? = v { full = a.count >= max }
                    r.value = v
                    r.options = optionsOf(doc, n).map { o in
                        let selected: Bool
                        if case .array(let a)? = v { selected = holds(a, o.value) } else { selected = same(v, .string(o.value)) }
                        return ResolvedOption(value: o.value, label: o.label, selected: selected, disabled: r.disabled || (full && !selected))
                    }
                case .button:
                    r.label = interpolate(n.label ?? "", doc, state)
                    if n.act != nil, let id = n.id, let a = act(doc, state, id) {
                        for e in a.effects {
                            switch e {
                            case .say(let text, _): r.caption = text
                            case .reply(let id, let slots): if !replyFits(doc, id, slots) { r.disabled = true }
                            }
                        }
                    }
                case .divider, .row: break
                }
                out.append(r)
                if n.kind == .row || n.kind == .group { visit(n.children, visible) }
            }
        }
        visit(doc.body, true)
        return out
    }
    private static func replyFits(_ doc: Doc, _ id: String, _ slots: [String: JSONValue]) -> Bool {
        guard let stub = doc.replies.first(where: { $0.id == id }) else { return false }
        return stub.slots.allSatisfy { slotOk($0.value, slots[$0.key]) }
    }
    /// JavaScript truthiness, for a checkbox's toggle of whatever the state holds.
    private static func truthy(_ v: JSONValue?) -> Bool {
        switch v {
        case nil, .null?: false
        case .bool(let b)?: b
        case .number(let d)?: d != 0 && !d.isNaN
        case .string(let s)?: !s.isEmpty
        case .array?, .object?: true
        }
    }

    /// A UI action on a control → the new state and the event its `on` handler gets (nil for a commit, which fires no
    /// handler), or nil when the action does not apply: an unknown, hidden or disabled control (under `lock` as well),
    /// the wrong action, a value that is not allowed, no change of a choice.
    public static func applyAction(_ doc: Doc, _ state: State, _ nodeId: String, _ action: Action, lock: LockReason? = nil) -> Applied? {
        guard let r = resolve(doc, state, lock).first(where: { $0.node.id == nodeId }), r.visible, !r.disabled else { return nil }
        let n = r.node
        var s = state
        switch (n.kind, action) {
        case (.checkbox, .toggle):
            s[n.bind!] = .bool(!truthy(s[n.bind!]))
            return Applied(state: s, event: Event(type: .change, node: nodeId, value: s[n.bind!]!))
        case (.choice, .select(let value)):
            guard let o = r.options?.first(where: { same($0.value, value) }), !o.disabled else { return nil }
            let d = doc.state[n.bind!]!
            if case .set(let values, _) = d {
                let v = s[n.bind!]?.array ?? []
                let next = o.selected ? v.filter { !same($0, .string(o.value)) } : v + [.string(o.value)]
                s[n.bind!] = .array(values.map(\.value).filter { holds(next, $0) }.map(JSONValue.string))   // schema order
            } else {
                if o.selected { return nil }   // no deselect
                s[n.bind!] = .string(o.value)
            }
            return Applied(state: s, event: Event(type: .change, node: nodeId, value: s[n.bind!]!))
        case (.input, .submit(let value)), (.input, .commit(let value)):
            guard validValue(doc.state[n.bind!]!, .string(value)) else { return nil }
            s[n.bind!] = .string(value)
            guard case .ok = validateState(doc, s) else { return nil }
            if case .commit = action { return Applied(state: s, event: nil) }
            return Applied(state: s, event: Event(type: .submit, node: nodeId, value: .string(value)))
        case (.button, .click):
            return Applied(state: s, event: Event(type: .click, node: nodeId, value: .null))
        default: return nil
        }
    }

    /// A button's declarative act: `set` first, then `say` interpolated from the new state, then `reply`, whose slots are
    /// filled from the state keys of the same names. Nil when the node has no act. It does not check the lock, show_if
    /// or enable_if: call it only for a click that applyAction accepted. The effects are checked like a script's
    /// (checkEffects) before anything is sent.
    public static func act(_ doc: Doc, _ state: State, _ nodeId: String) -> ActOutcome? {
        guard let n = findNode(doc, nodeId), n.kind == .button, let a = n.act else { return nil }
        var s = state, effects: [Effect] = []
        for (k, v) in a.set ?? [:] { s[k] = v }
        if let say = a.say { effects.append(.say(text: interpolate(say, doc, s), kind: a.sayKind ?? .ic)) }
        if let reply = a.reply, let stub = doc.replies.first(where: { $0.id == reply }) {
            var slots: [String: JSONValue] = [:]
            for k in stub.slots.keys { if let v = s[k] { slots[k] = v } }
            effects.append(.reply(id: stub.id, slots: slots))
        }
        return ActOutcome(state: s, effects: effects)
    }

    // MARK: - Dice policy (dice.ts)

    // Which dot commands a card may post as the clicker. A mirror of dice::parseCommand (backend/src/dice/Dice.cpp): an
    // ASCII trim, a "。"/"．" prefix read as ".", the literals tried case-insensitively (ASCII only) in exactly that order,
    // and the rule for the character after a literal. The server's hypertext::diceVerdict is authoritative; the shared
    // fixture's dice_policy pins both. It reads UTF-16 code units, as the TypeScript does.
    public struct Command: Equatable, Sendable {
        public let name: String
        public let args: String
        public let raw: String
        public let hidden: Bool
    }
    private static let literals: [(String, String)] = [
        ("move", "move"), ("init", "init"), ("rah", "ra"), ("rch", "ra"), ("ra", "ra"), ("rc", "ra"), ("rih", "ri"), ("ri", "ri"), ("rh", "r"), ("r", "r"),
        ("sc", "sc"), ("st", "st"), ("en", "en"), ("ds", "ds"), ("ss", "ss"),
    ]
    public static func parseCommand(_ content: String) -> Command? {
        var s = asciiTrim(content)
        // Compared by code point: hasPrefix compares whole characters, and a combining mark would hide the prefix.
        if let first = s.unicodeScalars.first, first == "。" || first == "．" { s = "." + String(s.unicodeScalars.dropFirst()) }
        let units = Array(s.utf16)
        guard units.count >= 2, units[0] == 0x2e else { return nil }
        let rest = Array(units.dropFirst())
        let lower: (UInt16) -> UInt16 = { $0 >= 0x41 && $0 <= 0x5a ? $0 + 32 : $0 }
        for (lit, name) in literals {
            let l = Array(lit.utf16), n = l.count
            guard rest.count >= n, (0..<n).allSatisfy({ lower(rest[$0]) == l[$0] }) else { continue }
            if rest.count > n {
                // As in C++: ASCII space, a digit, any non-ASCII character, one of "(%#+-/" (strchr also finds the NUL
                // terminator), or a d after the bare r.
                let c = rest[n]
                let ok = c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d || (0x30...0x39).contains(c) || c >= 0x80 || c == 0
                    || [0x28, 0x25, 0x23, 0x2b, 0x2d, 0x2f].contains(c) || (lit == "r" && (c == 0x64 || c == 0x44))
                if !ok { continue }
            }
            // The literal is ASCII, so dropping its code units drops as many scalars.
            let args = String(String.UnicodeScalarView(s.unicodeScalars.dropFirst(1 + n)))
            return Command(name: name, args: asciiTrim(args), raw: "." + lit, hidden: ["rah", "rch", "rh", "rih"].contains(lit))
        }
        return nil
    }

    public enum Verdict: String, Sendable { case allowed, confirm, refused, none }
    private static func space(_ c: UInt16) -> Bool { c == 0x20 || (0x09...0x0d).contains(c) }   // C isspace in the C locale
    private static func digit(_ c: UInt16) -> Bool { (0x30...0x39).contains(c) }
    private static func alpha(_ c: UInt16) -> Bool { (0x61...0x7a).contains(c | 0x20) }          // ASCII letters only

    /// ri/rih join the initiative order as the speaking character only when nothing in the arguments names someone else:
    /// signed modifiers (+2, - 1, +1d4, +d6) and the words adv/advantage/dis/disadvantage (any case), each ending at a
    /// space, a sign or the end. A port of hypertext::modifiersOnly (backend/src/chat/Hypertext.cpp).
    public static func modifiersOnly(_ args: String) -> Bool {
        let a = Array(args.utf16), n = a.count
        let boundary: (Int) -> Bool = { k in k >= n || space(a[k]) || a[k] == 0x2b || a[k] == 0x2d }
        var i = 0
        while true {
            while i < n && space(a[i]) { i += 1 }
            if i >= n { return true }
            if a[i] == 0x2b || a[i] == 0x2d {
                i += 1
                while i < n && space(a[i]) { i += 1 }
                let start = i
                while i < n && digit(a[i]) { i += 1 }
                let count = i > start
                if i < n && a[i] | 0x20 == 0x64 {                      // NdM, or dM
                    i += 1
                    let b = i
                    while i < n && digit(a[i]) { i += 1 }
                    if i == b { return false }
                } else if !count { return false }
                if !boundary(i) { return false }
            } else {
                let start = i
                while i < n && alpha(a[i]) { i += 1 }
                let w = String(decoding: a[start..<i], as: UTF16.self).lowercased()
                if !["adv", "advantage", "dis", "disadvantage"].contains(w) || !boundary(i) { return false }
            }
        }
    }

    /// allowed: r/rh, ra/rc/rah/rch, ri/rih with modifiers only. confirm (the server answers 428): sc, ds, which change
    /// the sheet. refused: ri with a name, st, en, ss, init, move. none: not a command (free text, confirmed by the
    /// viewer).
    public static func verdict(_ text: String) -> Verdict {
        guard let cmd = parseCommand(text) else { return .none }
        switch cmd.name {
        case "r", "ra": return .allowed
        case "ri": return modifiersOnly(cmd.args) ? .allowed : .refused
        case "sc", "ds": return .confirm
        default: return .refused
        }
    }

    /// r/rh arguments that are only an expression: an optional "N#" repeat, then the characters of dice::parseRoll's
    /// expression prefix with no space (/^(\d+#[ \t\n\v\f\r]*)?[0-9dD%+\-*\/()kKhHlL]*$/).
    private static func expressionOnly(_ args: String) -> Bool {
        let u = Array(args.unicodeScalars)
        let allowed = Set("0123456789dD%+-*/()kKhHlL".unicodeScalars)
        var i = 0
        while i < u.count && (0x30...0x39).contains(u[i].value) { i += 1 }
        if i > 0 && i < u.count && u[i] == "#" {
            var k = i + 1
            while k < u.count && (u[k].value == 0x20 || (0x09...0x0d).contains(u[k].value)) { k += 1 }
            if u[k...].allSatisfy({ allowed.contains($0) }) { return true }
        }
        return u.allSatisfy { allowed.contains($0) }
    }
    /// Whether an allowed roll is nothing but the roll, so a script may post it as the clicker without asking. Bare: one
    /// line, and for r/rh only an expression; for ra/rc/rah/rch at most 32 code points and 3 words after the command,
    /// numbers and signed numbers not counted; for ri/rih modifiers only.
    public static func bareRoll(_ text: String) -> Bool {
        let t = asciiTrim(text)
        guard let cmd = parseCommand(t), !t.unicodeScalars.contains(where: { [0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029].contains($0.value) }) else { return false }
        switch cmd.name {
        case "r": return expressionOnly(cmd.args)
        case "ra":
            let words = cmd.args.unicodeScalars.split { $0 == " " || $0 == "\t" }.map { Array($0) }
            let counted = words.filter { w in
                let digits = w.first == "+" || w.first == "-" ? w.dropFirst() : w[...]
                return !digits.allSatisfy { (0x30...0x39).contains($0.value) }
            }
            return cpLength(cmd.args) <= 32 && counted.count <= 3
        case "ri": return modifiersOnly(cmd.args)
        default: return false
        }
    }

    // MARK: - Host validation (effects.ts)

    public enum OutputLimits {
        public static let bytes = 16384, depth = 16, sayCp = 500, sayLines = 5, notices = 3, noticeCp = 200, logs = 20, logCp = 200, messageCp = 200
        /// A request to the engine and its answer (the web's CLIENT_LIMITS.messageBytes).
        public static let messageBytes = 65536
    }
    /// The engine bundle this app ships (`MobileHypertext.version`, fixture `engine.version`).
    public static let engineVersion = "hypertext-1 quickjs-emscripten-0.32.0"
    /// The bundle's own wall-clock backstops, in seconds (fixture `engine.limits` timeout_ms and cold_timeout_ms): it
    /// answers `timeout` itself at these marks, so a native host's timeout must be longer (with a margin, and counted
    /// from the page's load for a cold start).
    public static let engineTimeout = 1.0, engineColdTimeout = 5.0
    public static func failure(_ code: ErrorCode, _ message: String, line: Int? = nil) -> RunResult { .failed(engineError(code, message, line: line), logs: []) }
    /// A failure as the bundle would answer it, for a native host that has to answer for it (its own timeout:
    /// `.timeout`, "the script did not finish in time"; a page that could not load: `.engine`).
    public static func failureText(_ code: ErrorCode, _ message: String) -> String {
        jsonText(.object(["ok": .bool(false), "error": .object(["code": .string(code.rawValue), "message": .string(cpPrefix(sanitize(message), OutputLimits.messageCp))])]))
    }
    /// An engine error as it is shown: its message sanitized and cut to 200 code points.
    public static func engineError(_ code: ErrorCode, _ message: String, line: Int? = nil) -> EngineError {
        EngineError(code: code, message: cpPrefix(sanitize(message), OutputLimits.messageCp), line: line)
    }

    /// The say's text as it will be posted (ASCII-trimmed, as the server trims), or why it cannot be.
    public static func checkSay(_ text: JSONValue?, _ kind: JSONValue?) -> Result<String, Invalid> {
        guard kind == .string("ic") || kind == .string("ooc") else { return .failure(Invalid(message: "say: kind must be 'ic' or 'ooc'")) }
        guard case .string(let raw)? = text else { return .failure(Invalid(message: "say: text must be a string")) }
        let t = asciiTrim(raw)
        guard boundedText(t, OutputLimits.sayCp, multiline: true, min: 1) else { return .failure(Invalid(message: "say: 1 to 500 characters, no control or direction characters")) }
        guard lineCount(t) <= OutputLimits.sayLines else { return .failure(Invalid(message: "say: at most 5 lines")) }
        guard verdict(t) != .refused else { return .failure(Invalid(message: "say: this command cannot be posted from an interactive message")) }
        return .success(t)
    }

    /// At most one say and one reply; a reply only to a declared stub, with exactly its slots and allowed values.
    public static func checkEffects(_ doc: Doc, _ raw: JSONValue?) -> Result<[Effect], Invalid> {
        let fail = { (m: String) in Result<[Effect], Invalid>.failure(Invalid(message: m)) }
        guard case .array(let list)? = raw, list.count <= 2 else { return fail("effects: at most one say and one reply") }
        var effects: [Effect] = []
        for e in list {
            guard case .object(let o) = e else { return fail("effects: each effect must be an object") }
            if o["type"] == .string("say") {
                if effects.contains(where: { if case .say = $0 { true } else { false } }) { return fail("say: at most once per action") }
                if o.keys.contains(where: { !["type", "text", "kind"].contains($0) }) { return fail("say: unknown field") }
                switch checkSay(o["text"], o["kind"]) {
                case .failure(let f): return .failure(f)
                case .success(let text): effects.append(.say(text: text, kind: SayKind(rawValue: o["kind"]?.text ?? "") ?? .ic))
                }
            } else if o["type"] == .string("reply") {
                if effects.contains(where: { if case .reply = $0 { true } else { false } }) { return fail("reply: at most once per action") }
                if o.keys.contains(where: { !["type", "id", "slots"].contains($0) }) { return fail("reply: unknown field") }
                guard case .string(let id)? = o["id"], let stub = doc.replies.first(where: { $0.id == id }) else { return fail("reply: not one of this message's replies") }
                guard case .object(let slots) = o["slots"] ?? .object([:]) else { return fail("reply: slots must be an object") }
                let names = stub.slots.keys.sorted(by: utf16Order)
                if slots.count != names.count || !names.allSatisfy({ slots[$0] != nil }) {
                    return fail("reply \(stub.id): slots must be exactly \(names.isEmpty ? "(none)" : names.joined(separator: ", "))")
                }
                var out: [String: JSONValue] = [:]
                for k in names {
                    guard slotOk(stub.slots[k]!, slots[k]) else { return fail("reply \(stub.id): slot \(k) is not an allowed value") }
                    out[k] = slots[k]
                }
                effects.append(.reply(id: stub.id, slots: out))
            } else { return fail("effects: unknown effect type") }
        }
        return .success(effects)
    }
    /// The same check for effects a declarative act produced.
    public static func checkEffects(_ doc: Doc, effects: [Effect]) -> Result<[Effect], Invalid> { checkEffects(doc, .array(effects.map(\.json))) }

    /// Free text (not a command) needs the viewer's confirmation; sc/ds too, with a sheet warning. An allowed roll runs
    /// directly only when it is a bare roll; any other text riding on a roll is confirmed like free text.
    public static func confirmFor(_ effects: [Effect]) -> Confirm? {
        for e in effects {
            guard case .say(let text, let kind) = e else { continue }
            let v = verdict(text)
            if v == .confirm { return Confirm(text: text, kind: kind, sheet: true) }
            return v == .allowed && bareRoll(text) ? nil : Confirm(text: text, kind: kind)
        }
        return nil
    }

    private static func logList(_ raw: JSONValue?) -> [String] {
        guard case .array(let list)? = raw else { return [] }
        return list.prefix(OutputLimits.logs).map { x in cpPrefix(sanitize(x.string ?? jsonText(x)), OutputLimits.logCp) }
    }

    /// The engine bundle's result (a RunResult as JSON text, `MobileHypertext.run`/`take`) checked again natively before
    /// anything is shown or sent, as effects.ts validateOutput checks the script's output: at most 64 KiB and 16 levels
    /// deep; a failure keeps a known code (else script_error), its message cut to 200 code points, a positive integer
    /// line and at most 20 logs. A success has no other keys than ok, state, effects, notices, logs, confirm and changed,
    /// a complete state that passes validateState, effects that pass checkEffects, at most 3 notices and 20 logs.
    /// `confirm` and `changed` are computed here (against `prev`, the state shown before the action), never taken from
    /// the page.
    public static func validateOutput(_ doc: Doc, prev: State, raw: String?) -> RunResult {
        guard let raw else { return failure(.engine, "the engine returned no output") }
        if utf8Bytes(raw) > OutputLimits.messageBytes { return failure(.invalidEffect, "the engine sent a reply that is too large or not valid") }
        if jsonDepth(raw) > OutputLimits.depth { return failure(.invalidEffect, "the script output is nested too deeply") }
        guard let out = try? JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8)) else { return failure(.invalidEffect, "the script output is not JSON") }
        guard case .object(let o) = out, case .bool(let ok)? = o["ok"] else { return failure(.invalidEffect, "the script output has no result") }
        if !ok {
            let e = object(o["error"]) ?? [:]
            let code = e["code"]?.string.flatMap(ErrorCode.init(rawValue:)) ?? .scriptError
            var line: Int? = nil
            if let d = integral(e["line"]), d > 0, d <= 9_007_199_254_740_991 { line = Int(d) }
            return .failed(engineError(code, e["message"]?.string ?? "the script failed", line: line), logs: logList(o["logs"]))
        }
        if let k = o.keys.sorted(by: utf16Order).first(where: { !["ok", "state", "effects", "notices", "logs", "confirm", "changed"].contains($0) }) {
            return failure(.invalidEffect, "unknown output field \(cpPrefix(k, 40))")
        }
        // The prelude hands the script every key and returns them all: a missing one was deleted by the script.
        if let given = object(o["state"]), let missing = doc.keys.first(where: { given[$0] == nil }) { return failure(.invalidState, "state.\(missing): missing") }
        let state: State
        switch validateState(doc, o["state"]) {
        case .invalid(_, let error): return failure(.invalidState, error)
        case .ok(let full): state = full
        }
        let effects: [Effect]
        switch checkEffects(doc, o["effects"] == nil || o["effects"] == .null ? .array([]) : o["effects"]) {
        case .failure(let f): return failure(.invalidEffect, f.message)
        case .success(let fx): effects = fx
        }
        let noticesRaw = o["notices"] == nil || o["notices"] == .null ? JSONValue.array([]) : o["notices"]!
        guard case .array(let notices) = noticesRaw, notices.count <= OutputLimits.notices else { return failure(.invalidEffect, "notify: at most 3 per action") }
        guard notices.allSatisfy({ boundedText($0, OutputLimits.noticeCp, multiline: true, min: 1) }) else {
            return failure(.invalidEffect, "notify: 1 to 200 characters, no control or direction characters")
        }
        if let logs = o["logs"] {
            guard case .array(let list) = logs, list.count <= OutputLimits.logs,
                  list.allSatisfy({ $0.string.map { cpLength($0) <= OutputLimits.logCp } == true }) else {
                return failure(.invalidEffect, "log: at most 20 entries of 200 characters")
            }
        }
        let changed = doc.keys.contains { !same(state[$0], prev[$0]) }
        return .ok(Run(state: state, effects: effects, notices: notices.map(\.text), logs: logList(o["logs"]), confirm: confirmFor(effects), changed: changed))
    }

    /// The request for `MobileHypertext.run`/`start` (`{doc, state, prev, handler, event, viewer}`): `doc` the message's
    /// `hypertext` as stored, `state` the state after the control's change, `prev` the state shown before it. Nil when it
    /// is over 64 KiB: the run then fails with invalid_state, "the action is too large to run".
    public static func engineRequest(doc: JSONValue, state: State, prev: State, handler: String, event: Event, viewer: Viewer) -> String? {
        let json = jsonText(.object(["doc": doc, "state": .object(state), "prev": .object(prev), "handler": .string(handler), "event": event.json, "viewer": viewer.json]))
        return utf8Bytes(json) <= OutputLimits.messageBytes ? json : nil
    }
}
