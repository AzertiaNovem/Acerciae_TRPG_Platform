import Foundation

/// One number of a character's entry in the list ("HP 9/12"); `low` marks hit points at a third or less.
public struct VitalPart: Equatable, Sendable {
    public let label: String
    public let value: String
    public let low: Bool
    public init(_ label: String, _ value: String, low: Bool = false) { self.label = label; self.value = value; self.low = low }
    public var text: String { value.isEmpty ? label : label + " " + value }
}

/// The few numbers that matter at the table, from `vitals` in a row of `GET /channels/{id}/characters`: Call of
/// Cthulhu HP, SAN and DEX; D&D HP, AC and DEX; PbtA the pack's resources and the marked conditions. A value the sheet
/// leaves blank reads "—"; a row without vitals (an older server) has no parts.
public enum Vitals {
    private static func number(_ value: JSONValue) -> Int? { if case .number(let v) = value { return Int(v) }; return nil }
    private static func show(_ value: Int?) -> String { if let value { return String(value) }; return "—" }
    private static func pair(_ value: Int?, _ top: Int?) -> String {
        if let top, top != 0 { return show(value) + "/" + String(top) }
        return show(value)
    }
    public static func parts(_ vitals: JSONValue) -> [VitalPart] {
        guard case .object(let fields) = vitals, !fields.isEmpty else { return [] }
        let rules = vitals["rule_system"].text
        if rules == "pbta" {
            let resources = vitals["resources"].array.map { VitalPart($0["name"].text, show(number($0["value"]))) }
            let conditions = vitals["conditions"].array.map { VitalPart($0["name"].text, "") }
            return resources + conditions
        }
        let hp = number(vitals["hp"])
        let top = number(vitals["hp_max"])
        // A third of the maximum, rounded up; with no maximum on the card, only "down" counts.
        var low = false
        if let hp {
            if let top, top != 0 { low = hp <= (top + 2) / 3 } else { low = hp <= 0 }
        }
        let first = VitalPart("HP", pair(hp, top), low: low)
        let dex = VitalPart("DEX", show(number(vitals["dex"])))
        if rules == "dnd2024" { return [first, VitalPart("AC", show(number(vitals["ac"]))), dex] }
        return [first, VitalPart("SAN", pair(number(vitals["san"]), number(vitals["san_max"]))), dex]
    }
    public static func of(_ character: Resource) -> [VitalPart] { parts(character["vitals"]) }
}

/// One way to play the moment: the line in the character's voice, its kind, a dice command that may go with it, its stance.
public struct InspirationOption: Equatable, Sendable {
    public let text: String
    public let kind: String
    public let roll: String
    public let angle: String
    public init(text: String, kind: String = "ic", roll: String = "", angle: String = "") { self.text = text; self.kind = kind; self.roll = roll; self.angle = angle }
}

public enum Inspiration {
    public static let remembered = 12
    private static func blank(_ text: String) -> Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// The options of a `POST /channels/{id}/inspiration` result; a result with only `draft` reads as one option.
    public static func options(_ result: JSONValue) -> [InspirationOption] {
        var listed: [InspirationOption] = []
        for row in result["options"].array where !blank(row["text"].text) {
            let kind = row["kind"].text
            listed.append(InspirationOption(text: row["text"].text, kind: kind.isEmpty ? "ic" : kind, roll: row["roll"].text, angle: row["angle"].text))
        }
        if !listed.isEmpty { return listed }
        let draft = result["draft"].text
        return blank(draft) ? [] : [InspirationOption(text: draft)]
    }
    /// What was shown so far, newest last: "Another take" sends it as `avoid` so the next three differ.
    public static func shown(_ before: [String], _ result: JSONValue) -> [String] {
        var all: [String] = []
        for text in before + options(result).map({ $0.text }) where !all.contains(text) { all.append(text) }
        return Array(all.suffix(remembered))
    }
}

/// Pinned lines: reminders of kind `pinned`, kept among a group's hints until their pinner or the GM unpins them.
public enum Pins {
    public static func of(_ reminders: [Resource], messageId: String) -> Resource? {
        reminders.first { $0["kind"].text == "pinned" && $0["pinned_message_id"].text == messageId }
    }
    public static func canPin(_ message: Message) -> Bool { !message.recalled && message.kind != "system" }
    public static func canUnpin(_ pin: Resource, userId: String?, gm: Bool) -> Bool {
        guard pin["kind"].text == "pinned" else { return false }
        if gm { return true }
        guard let userId, !userId.isEmpty else { return false }
        return pin["pinned_by"].text == userId
    }
}
