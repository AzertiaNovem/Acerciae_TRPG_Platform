import SwiftUI
import AcerciaeCore

struct DiceResultView: View {
    let message: Message
    private var tone: Color {
        switch message.diceTone {
        case .success, .critical: Color(red: 0.36, green: 0.78, blue: 0.52)
        case .failure, .fumble: Color(red: 0.9, green: 0.43, blue: 0.47)
        default: .secondary
        }
    }
    private var emphasized: Bool { [.critical, .fumble].contains(message.diceTone) }
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let command = message.diceCommand {
                Text(command).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
            }
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: message.diceTone == .notice ? "lock" : "die.face.5").foregroundStyle(tone).padding(.top, 2)
                VStack(alignment: .leading, spacing: 5) {
                    if message.dice?["hidden"].bool == true && message.diceTone != .notice { Text(tr("暗骰")).font(.caption).foregroundStyle(.secondary) }
                    if let dice = message.dice, message.hasStructuredPbtaResult {
                        Text(dice["name"].text).font(.headline)
                        Text(dice["trigger"].text).font(.caption).foregroundStyle(.secondary)
                        if !dice["rolls"].array.isEmpty {
                            if !dice["stat_name"].text.isEmpty { Text(dice["stat_name"].text).font(.caption) }
                            Text("2d6 [" + dice["rolls"].array.map { String($0.int) }.joined(separator:", ") + "] + \(dice["stat_value"].int) + (\(dice["modifier"].int)) = \(dice["total"].int)").monospacedDigit()
                            Text(dice["band"]["name"].text).fontWeight(.semibold)
                            Text(dice["outcome"].text).textSelection(.enabled)
                        }
                        if dice["player_choice"].bool { Text(tr("Player choice")).font(.caption) }
                    } else {
                        Text(message.displayText).fontWeight(emphasized ? .semibold : .regular).monospacedDigit().textSelection(.enabled)
                            .foregroundStyle(message.diceTone == .notice ? .secondary : .primary)
                    }
                }
            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(tone.opacity(emphasized ? 0.16 : 0.08), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(tone.opacity(emphasized ? 0.9 : 0.4), lineWidth: 1))
        }
    }
}
