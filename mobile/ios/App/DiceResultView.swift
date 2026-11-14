import SwiftUI
import ImageIO
import AcerciaeCore

/// The palette shared with the web: one colour per outcome.
func diceColor(_ tone: DiceTone) -> Color {
    switch tone {
    case .critical: Color(red: 0.95, green: 0.72, blue: 0.18)
    case .extreme: Color(red: 0.72, green: 0.49, blue: 0.95)
    case .hard: Color(red: 0.31, green: 0.64, blue: 0.97)
    case .success: Color(red: 0.25, green: 0.75, blue: 0.45)
    case .failure: Color(red: 0.94, green: 0.54, blue: 0.24)
    case .fumble: Color(red: 0.94, green: 0.29, blue: 0.36)
    case .roll: Color(red: 0.21, green: 0.76, blue: 0.76)
    case .neutral, .notice: Color(red: 0.55, green: 0.59, blue: 0.66)
    }
}

/// A roll's result card; `showCommand` adds the typed command above it (results shown under the command).
struct DiceResultView: View {
    let message: Message
    var showCommand = true
    private var tone: Color { message.diceTone == .notice ? .secondary : diceColor(message.diceTone) }
    private var emphasized: Bool { [.critical, .fumble].contains(message.diceTone) }
    /// A result line with its numbers in bold, in the line's colour.
    private func styled(_ line: String, _ color: Color) -> AttributedString {
        var text = AttributedString(line)
        for range in DiceDisplay.numberRanges(in: line) {
            guard let lower = AttributedString.Index(range.lowerBound, within: text), let upper = AttributedString.Index(range.upperBound, within: text) else { continue }
            text[lower..<upper].font = .body.bold()
            text[lower..<upper].foregroundColor = color
        }
        return text
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if showCommand, let command = message.diceCommand {
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
                    } else if message.diceTone == .notice {
                        Text(message.displayText).foregroundStyle(.secondary).textSelection(.enabled)
                    } else {
                        let lines = message.diceLines
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                                let color = diceColor(line.tone)
                                HStack(spacing: 6) {
                                    if lines.count > 1 { Rectangle().fill(color).frame(width: 2) }
                                    Text(styled(line.text, color)).fontWeight(emphasized ? .semibold : .regular).monospacedDigit()
                                }.fixedSize(horizontal: false, vertical: true)
                            }
                        }.textSelection(.enabled)
                    }
                }
            }.padding(12).padding(.leading, 4).frame(maxWidth: .infinity, alignment: .leading)
                .background(tone.opacity(emphasized ? 0.2 : 0.12), in: RoundedRectangle(cornerRadius: 12))
                .overlay(alignment: .leading) { UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 12).fill(tone).frame(width: 4) }
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(tone.opacity(emphasized ? 0.95 : 0.55), lineWidth: emphasized ? 1.5 : 1))
        }
    }
}

@MainActor private enum DiceAvatarCache {
    static let images: NSCache<NSString, UIImage> = { let cache = NSCache<NSString, UIImage>(); cache.countLimit = 16; return cache }()
}
/// The dice persona's picture (uploaded to the channel's text group), or a die in the outcome's colour.
struct DiceAvatarView: View {
    @ObservedObject var model: AppModel
    let bot: DiceBot?
    let tone: Color
    var size: CGFloat = 32
    @State private var image: UIImage?
    private var key: String? { bot.flatMap { !$0.groupId.isEmpty && $0.avatarVersion > 0 ? "\($0.groupId):\($0.avatarVersion)" : nil } }
    var body: some View {
        ZStack {
            Circle().fill(tone.opacity(0.3))
            if let image { Image(uiImage: image).resizable().scaledToFill() } else { Text("🎲").font(.system(size: size * 0.5)) }
        }.frame(width: size, height: size).clipShape(Circle()).accessibilityHidden(true)
        .task(id: key) {
            image = nil
            guard let key, let bot else { return }
            if let cached = DiceAvatarCache.images.object(forKey: key as NSString) { image = cached; return }
            guard let bytes = try? await model.bytes(["dice-avatars", bot.groupId], query: ["v": String(bot.avatarVersion)], hash: nil),
                  !Task.isCancelled, let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 216, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return }
            let decoded = UIImage(cgImage: thumbnail)
            DiceAvatarCache.images.setObject(decoded, forKey: key as NSString); image = decoded
        }
    }
}

/// The dice answering as their own message: the persona's avatar and name, then the result.
struct DiceBotRow: View {
    let message: Message
    @ObservedObject var model: AppModel
    /// This row stands alone for its line (a hidden roll's notice), so it carries the line's pill.
    var provenance = false
    private var tone: Color { diceColor(message.diceTone == .notice ? .neutral : message.diceTone) }
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            DiceAvatarView(model: model, bot: message.diceBot, tone: tone)
            VStack(alignment: .leading, spacing: 6) {
                Text(message.diceBot?.name.isEmpty == false ? message.diceBot!.name : tr("Dice")).font(.caption.weight(.semibold)).foregroundStyle(tone)
                // A card's hidden roll announces itself with the same "via interactive message" as the roll line.
                if provenance && message.viaHypertextId != nil { HypertextViaPill(answering: message.answering) }
                DiceResultView(message: message, showCommand: false)
            }
            Spacer(minLength: 36)
        }
    }
}
