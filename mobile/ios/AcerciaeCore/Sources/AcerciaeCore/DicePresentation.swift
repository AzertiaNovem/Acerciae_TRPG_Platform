import Foundation

public enum DiceTone: String { case neutral, success, failure, critical, fumble, notice }
public extension Message {
    var hasStructuredPbtaResult: Bool {
        guard let dice, dice["type"].text == "pbta_move", !dice["name"].text.isEmpty else { return false }
        return dice["rolls"].array.isEmpty || dice["total"] != .null
    }
    var diceTone: DiceTone {
        guard let dice else { return .neutral }
        if dice["type"].text == "hidden_notice" { return .notice }
        let last = dice["rolls"].array.last ?? .null
        let level = last["level"].string ?? dice["level"].text
        if dice["critical"] == .bool(true) || level == "critical" { return .critical }
        if level == "fumble" { return .fumble }
        if last["success"] == .bool(true) || dice["success"] == .bool(true) { return .success }
        if last["success"] == .bool(false) || dice["success"] == .bool(false) { return .failure }
        return .neutral
    }
    var diceCommand: String? { dice == nil || diceTone == .notice ? nil : content }
}
