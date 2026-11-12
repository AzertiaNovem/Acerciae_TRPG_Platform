import Foundation

/// Every outcome has its colour (the same palette as the web): success levels, plain rolls (`roll`) and sheet replies (`neutral`).
public enum DiceTone: String { case neutral, roll, success, hard, extreme, critical, failure, fumble, notice }

private func levelTone(_ level: String) -> DiceTone? {
    switch level {
    case "critical": .critical
    case "extreme": .extreme
    case "hard": .hard
    case "regular": .success
    case "failure": .failure
    case "fumble": .fumble
    default: nil
    }
}
private func toneOf(_ roll: JSONValue, fallback: DiceTone) -> DiceTone {
    if let tone = levelTone(roll["level"].text) { return tone }
    if roll["critical"] == .bool(true) { return .critical }
    if roll["success"] == .bool(true) { return .success }
    if roll["success"] == .bool(false) { return .failure }
    return fallback
}

public extension Message {
    var hasStructuredPbtaResult: Bool {
        guard let dice, dice["type"].text == "pbta_move", !dice["name"].text.isEmpty else { return false }
        return dice["rolls"].array.isEmpty || dice["total"] != .null
    }
    private var neutralTone: DiceTone { dice?["type"].text == "roll" ? .roll : .neutral }
    /// The roll's colour: the last roll's success level (else the result's), then whether it succeeded.
    var diceTone: DiceTone {
        guard let dice else { return .neutral }
        if dice["type"].text == "hidden_notice" { return .notice }
        let last = dice["rolls"].array.last ?? .null
        if let tone = levelTone(last["level"].string ?? dice["level"].text) { return tone }
        if dice["critical"] == .bool(true) { return .critical }
        if last["success"] == .bool(true) || dice["success"] == .bool(true) { return .success }
        if last["success"] == .bool(false) || dice["success"] == .bool(false) { return .failure }
        return neutralTone
    }
    /// One colour per line of the result: a repeated check (".ra 3#str") has a line, and a roll, for each attempt.
    var diceLines: [(text: String, tone: DiceTone)] {
        guard let dice else { return [] }
        let lines = displayText.components(separatedBy: "\n")
        let rolls = dice["rolls"].array.filter { if case .object = $0 { return true }; return false }
        let tone = diceTone
        return lines.enumerated().map { i, line in (line, lines.count > 1 && rolls.count == lines.count ? toneOf(rolls[i], fallback: neutralTone) : tone) }
    }
    var diceCommand: String? { dice == nil || diceTone == .notice ? nil : content }
    /// Who the dice spoke as (the channel's text group: nickname and avatar), recorded on the roll.
    var diceBot: DiceBot? {
        guard let bot = dice?["bot"], case .object = bot else { return nil }
        return DiceBot(name: bot["name"].text, groupId: bot["group_id"].text, avatarVersion: bot["avatar_version"].int)
    }
}
public struct DiceBot: Equatable, Sendable {
    public let name: String
    public let groupId: String
    public let avatarVersion: Int
    public init(name: String, groupId: String, avatarVersion: Int) { self.name = name; self.groupId = groupId; self.avatarVersion = avatarVersion }
}
/// The account's choice: results as a separate message from the dice (default), or under the command ("inline").
public enum DiceDisplay {
    public static let separate = "separate"
    public static let inline = "inline"
    public static func isSeparate(_ user: User?) -> Bool { user?.diceDisplay != inline }
    /// The numbers in a result line to emphasise: totals, targets and the dice that fell; dice notation (D100, 3d6) stays plain.
    public static func numberRanges(in line: String) -> [Range<String.Index>] {
        guard let pattern = try? NSRegularExpression(pattern: "(?<![A-Za-z\\d])\\d+(?![A-Za-z\\d])") else { return [] }
        return pattern.matches(in: line, range: NSRange(line.startIndex..., in: line)).compactMap { Range($0.range, in: line) }
    }
}
