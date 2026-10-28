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
                    Text(message.displayText).fontWeight(emphasized ? .semibold : .regular).monospacedDigit().textSelection(.enabled)
                        .foregroundStyle(message.diceTone == .notice ? .secondary : .primary)
                }
            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(tone.opacity(emphasized ? 0.16 : 0.08), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(tone.opacity(emphasized ? 0.9 : 0.4), lineWidth: 1))
        }
    }
}
