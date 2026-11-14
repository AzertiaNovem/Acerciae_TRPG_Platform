import SwiftUI
import UIKit
import AcerciaeCore

// Interactive messages (kind "hypertext", docs/HYPERTEXT.md), drawn natively the way frontend/src/components/
// HypertextCard.tsx draws them: plain text only, every card string isolated (U+2068 … U+2069, the web's <bdi>) and drawn
// with Text(verbatim:), native controls that hand their action to the store (AcerciaeCore/HypertextStore.swift). What
// is locked and what the footer says comes from Hypertext.present; this file only draws it. Spectators get the card
// read-only from its document: no status, no state, no engine.

private let good = diceColor(.success), danger = diceColor(.fumble), warn = diceColor(.critical)

/// The interactive messages of the signed-in session: the store and the engine host, published to the card views.
@MainActor final class HypertextCards: ObservableObject {
    let store: HypertextStore
    let engine = HypertextEngine()
    /// `sessionLost`: a card route got a 401 for the session in use; the app signs out as for any other route.
    init(session: @escaping @MainActor () -> (client: BackendClient, token: String)?, sessionLost: @escaping @MainActor (Error) -> Void) {
        store = HypertextStore(transport: .live(session, sessionLost: sessionLost))
        store.onChange = { [weak self] in self?.objectWillChange.send() }
        if HypertextEngine.available { store.engine = { [weak self] _, request in await self?.engine.run(request) } }
        store.disposeEngine = { [weak self] in self?.engine.release() }
    }
    /// The engine can run here: the page is packaged and has not answered that WebAssembly is missing.
    var engineReady: Bool { HypertextEngine.available && !store.engineMissing }
}

/// An interactive message's body in the chat: its card, or its plain text with a hint when this app cannot read it.
struct HypertextBody: View {
    let message: Message
    @ObservedObject var model: AppModel
    var body: some View {
        if let doc = Hypertext.parseDoc(message.hypertext) {
            if model.online { HypertextCardView(message: message, doc: doc, model: model, cards: model.cards) }
            else { HypertextSpectatorCard(doc: doc) }
        } else { HypertextFallback(content: message.content) }
    }
}

/// The pill a card's row shows beside the sender: what kind of line it is (the catalog has no word for the kind itself).
struct HypertextPill: View {
    var body: some View {
        Text(tr(Hypertext.Sentence.pill)).font(.caption2.weight(.semibold)).foregroundStyle(accent).lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(accent.opacity(0.14), in: Capsule())
            .overlay(Capsule().stroke(accent.opacity(0.38)))
    }
}

/// The pill of a line an interactive message posted: "↳ via interactive message", and whom it answered when someone
/// other than its author acted on the card (`Message.answering`).
struct HypertextViaPill: View {
    let answering: String?
    var body: some View {
        let via = "↳ " + tr(Hypertext.Sentence.via) + (answering.map { " · " + Hypertext.fill(tr(Hypertext.Sentence.answering), ["name": $0]) } ?? "")
        Text(verbatim: via).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Color.white.opacity(0.06), in: Capsule())
            .accessibilityHint(tr(Hypertext.Sentence.viaHint))
    }
}

/// A card this app cannot read (an unknown version, or malformed): its fallback text and a hint.
struct HypertextFallback: View {
    let content: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: content).textSelection(.enabled)
            Text(tr(Hypertext.Sentence.update)).font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// A card in a spectator's view: its document with the default state, every control locked.
struct HypertextSpectatorCard: View {
    let doc: Hypertext.Doc
    var body: some View {
        HypertextFace(doc: doc, card: Hypertext.present(doc, entry: nil, facts: Hypertext.spectatorFacts()), entry: nil, gmTools: false, confirm: [])
    }
}

/// A card of the open channel: this viewer's status of it, their actions, and the GM's tools.
private struct HypertextCardView: View {
    let message: Message
    let doc: Hypertext.Doc
    @ObservedObject var model: AppModel
    @ObservedObject var cards: HypertextCards
    @State private var now = Date()
    @State private var closing = false
    init(message: Message, doc: Hypertext.Doc, model: AppModel, cards: HypertextCards) {
        self.message = message; self.doc = doc; self.model = model; self.cards = cards
    }
    var body: some View {
        let viewing = model.cardViewing(message, doc: doc, now: now)
        let entry = cards.store.cards[message.id]
        let card = Hypertext.present(doc, entry: entry, facts: viewing.facts)
        HypertextFace(doc: doc, card: card, entry: entry, gmTools: viewing.facts.gm, confirm: entry?.confirm.map { confirmation($0, viewing) } ?? [], closing: closing,
                      fire: { node, action in fire(node, action, card: card, viewing: viewing) },
                      answer: { ok in cards.store.answer(message.id, ok) },
                      close: close)
            // Closed at closes_at: drawn again at that moment while the card is on screen.
            .task(id: card.closesAt) {
                guard let at = card.closesAt else { return }
                let wait = at.timeIntervalSinceNow + 0.05
                guard wait < 2_147_483 else { return }
                if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
                if !Task.isCancelled { now = Date() }
            }
    }
    // "Post as {name}: {text}": the composer's character in character, the account out of character.
    private func confirmation(_ c: Hypertext.Confirm, _ viewing: Hypertext.Viewing) -> [Hypertext.Segment] {
        let line = Hypertext.confirmLine(c, characterName: viewing.characterName, accountName: model.session?.user.displayName ?? "")
        return Hypertext.segments(tr(line.sentence), line.values)
    }
    private func fire(_ node: String, _ action: Hypertext.Action, card: Hypertext.Card, viewing: Hypertext.Viewing) {
        guard card.reason == nil, !card.busy else { return }
        let context = HypertextStore.Context(messageId: message.id, channelId: message.channelId ?? model.channelId, doc: doc, raw: message.hypertext ?? .null,
                                             lock: card.lock, viewer: viewing.viewer, engine: viewing.facts.engine, sayCharacterId: viewing.sayCharacterId,
                                             dice: viewing.dice)
        let store = cards.store
        Task { await store.interact(context, node: node, action: action) }
    }
    private func close() {
        guard !closing else { return }
        let store = cards.store, channel = message.channelId ?? model.channelId, id = message.id
        closing = true
        Task {
            do { try await store.close(channel: channel, id: id) } catch { model.cardFailure(error) }
            closing = false
        }
    }
}

/// A card as drawn: its title and nodes, then this viewer's notes, the confirmation, the outcome, the GM's script
/// details and the footer.
struct HypertextFace: View {
    let doc: Hypertext.Doc
    let card: Hypertext.Card
    let entry: Hypertext.CardEntry?
    /// GM tools (the script details and Close); never in a spectator's view.
    let gmTools: Bool
    /// The confirmation's sentence cut at its placeholders; empty while nothing waits.
    let confirm: [Hypertext.Segment]
    let closing: Bool
    let fire: (String, Hypertext.Action) -> Void
    let answer: (Bool) -> Void
    let close: () -> Void
    @State private var detailsOpen = false
    init(doc: Hypertext.Doc, card: Hypertext.Card, entry: Hypertext.CardEntry?, gmTools: Bool, confirm: [Hypertext.Segment], closing: Bool = false,
         fire: @escaping (String, Hypertext.Action) -> Void = { _, _ in }, answer: @escaping (Bool) -> Void = { _ in }, close: @escaping () -> Void = {}) {
        self.doc = doc; self.card = card; self.entry = entry; self.gmTools = gmTools; self.confirm = confirm; self.closing = closing
        self.fire = fire; self.answer = answer; self.close = close
    }
    private var announcement: String { ((entry?.notices ?? []) + (entry?.error.map { [tr($0)] } ?? [])).joined(separator: " ") }

    var body: some View {
        let draw = HypertextDraw(doc: doc, card: card, fire: fire)
        VStack(alignment: .leading, spacing: 8) {
            if !doc.title.isEmpty {
                Text(verbatim: Hypertext.isolate(doc.title)).font(.subheadline.weight(.bold)).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(doc.body, id: \.index) { HypertextNodeView(node: $0, draw: draw) }
            if let notices = entry?.notices, !notices.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(notices.enumerated()), id: \.offset) { _, notice in
                        Text(verbatim: Hypertext.isolate(notice)).font(.footnote).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
                .background(accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(accent.opacity(0.35)))
            }
            if let waiting = entry?.confirm { confirmRow(waiting) }
            if let error = entry?.error { Text(verbatim: tr(error)).font(.caption).foregroundStyle(danger).fixedSize(horizontal: false, vertical: true) }
            if gmTools, let entry, entry.failure != nil || !entry.logs.isEmpty { details(entry) }
            if card.showFooter { footer }
        }
        .frame(maxWidth: 560, alignment: .leading)
        .padding(.leading, 10)
        .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 1.5).fill(accent).frame(width: 3) }
        .onChange(of: entry?.failure) { _, failure in if failure != nil { detailsOpen = true } }
        .onChange(of: announcement) { _, text in if !text.isEmpty { UIAccessibility.post(notification: .announcement, argument: text) } }
    }

    private func confirmRow(_ waiting: Hypertext.Confirm) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            confirm.reduce(Text(verbatim: "")) { line, part in line + (part.key == "text" ? Text(verbatim: part.text).bold() : Text(verbatim: part.text)) }
                .font(.footnote).fixedSize(horizontal: false, vertical: true)
            if waiting.sheet { Text(tr(Hypertext.Sentence.sheet)).font(.caption2).foregroundStyle(.secondary) }
            HStack(spacing: 8) {
                Button { answer(true) } label: { Text(tr(Hypertext.Sentence.post)).foregroundStyle(ink) }.buttonStyle(.borderedProminent)
                Button(tr(Hypertext.Sentence.cancel)) { answer(false) }.buttonStyle(.bordered)
            }
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(warn.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(warn.opacity(0.45)))
        .accessibilityElement(children: .contain).accessibilityLabel(tr(Hypertext.Sentence.confirm))
    }

    private func details(_ entry: Hypertext.CardEntry) -> some View {
        DisclosureGroup(isExpanded: $detailsOpen) {
            VStack(alignment: .leading, spacing: 4) {
                if let failure = entry.failure {
                    let line = failure.line.map { " · " + Hypertext.fill(tr(Hypertext.Sentence.line), ["n": String($0)], isolated: false) } ?? ""
                    Text(verbatim: failure.code.rawValue + " " + Hypertext.isolate(failure.message) + line).font(.caption).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(Array(entry.logs.enumerated()), id: \.offset) { index, log in
                    Text(verbatim: "\(index + 1). " + Hypertext.isolate(log)).font(.caption2.monospaced()).fixedSize(horizontal: false, vertical: true)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            HStack(spacing: 4) {
                Text(tr(Hypertext.Sentence.scriptDetails)).font(.caption.weight(.semibold))
                Text(tr(Hypertext.Sentence.gmOnly)).font(.caption2).foregroundStyle(warn)
            }
        }
        .padding(8)
        .background(warn.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(warn.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    }

    private var footer: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                if let reason = card.reason { Text(tr(reason.sentence)) }
                if card.noEngine { Text(tr(Hypertext.Sentence.noEngine)) }
                if card.working { Text(tr(Hypertext.Sentence.working)) }
                if let left = card.usesLeft { Text(verbatim: Hypertext.fill(tr(Hypertext.Sentence.usesLeft), ["n": String(left)], isolated: false)) }
                if card.usedUp { Text(tr(Hypertext.Sentence.usedUp)) }
            }.fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if gmTools && card.showClose {
                Button(tr(Hypertext.Sentence.close), action: close).buttonStyle(.bordered).controlSize(.small).disabled(closing)
                    .accessibilityHint(tr(Hypertext.Sentence.closeHint))
            }
        }
        .font(.caption).foregroundStyle(.secondary)
    }
}

/// What every node of one card draws with.
private struct HypertextDraw {
    let doc: Hypertext.Doc
    let card: Hypertext.Card
    let fire: (String, Hypertext.Action) -> Void
    func resolved(_ node: Hypertext.Node) -> Hypertext.Resolved? { card.resolved.indices.contains(node.index) ? card.resolved[node.index] : nil }
    /// Locked for real: natively disabled.
    func off(_ node: Hypertext.Node) -> Bool { card.off.indices.contains(node.index) ? card.off[node.index] : true }
    /// An action of the card is under way: the other controls look disabled and do nothing meanwhile.
    var busy: Bool { card.busy }
}

private struct HypertextNodeView: View {
    let node: Hypertext.Node
    let draw: HypertextDraw
    var body: some View {
        if let r = draw.resolved(node), r.visible { content(r) }
    }
    @ViewBuilder private func content(_ r: Hypertext.Resolved) -> some View {
        let off = draw.off(node), wait = !off && draw.busy
        switch node.kind {
        case .text:
            Text(verbatim: Hypertext.isolate(r.text ?? ""))
                .font(textFont).foregroundStyle(textColor)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        case .divider:
            Divider()
        case .row:
            HypertextFlow(spacing: 8) { ForEach(node.children, id: \.index) { HypertextNodeView(node: $0, draw: draw) } }
        case .group:
            VStack(alignment: .leading, spacing: 8) {
                if let title = r.label { Text(verbatim: Hypertext.isolate(title)).font(.caption.weight(.semibold)).fixedSize(horizontal: false, vertical: true) }
                ForEach(node.children, id: \.index) { HypertextNodeView(node: $0, draw: draw) }
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(ink.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.15)))
        case .checkbox:
            HypertextCheckbox(node: node, r: r, off: off, wait: wait, fire: draw.fire)
        case .choice:
            HypertextChoice(node: node, r: r, multi: node.bind.flatMap { draw.doc.state[$0] }?.type == "set", off: off, wait: wait, fire: draw.fire)
        case .input:
            HypertextInput(node: node, r: r, max: node.bind.flatMap { draw.doc.state[$0] }.map(Self.maxLength) ?? 0, off: off, wait: wait, fire: draw.fire)
        case .button:
            HypertextButton(node: node, r: r, off: off, wait: wait, fire: draw.fire)
        }
    }
    private static func maxLength(_ decl: Hypertext.StateDecl) -> Int { if case .text(let max) = decl { return max }; return 0 }
    private var textFont: Font {
        switch node.style {
        case "heading": .headline
        case "strong": .body.weight(.semibold)
        case "muted": .footnote
        default: .body
        }
    }
    private var textColor: Color {
        switch node.tone {
        case "good": good
        case "bad": danger
        case "warn": warn
        default: node.style == "muted" ? .secondary : .primary
        }
    }
}

private struct HypertextCheckbox: View {
    let node: Hypertext.Node
    let r: Hypertext.Resolved
    let off: Bool
    let wait: Bool
    let fire: (String, Hypertext.Action) -> Void
    var body: some View {
        let on = r.value == .bool(true)
        Button { if !wait { fire(node.id ?? "", .toggle) } } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: on ? "checkmark.square.fill" : "square").foregroundStyle(off ? Color.secondary : accent)
                Text(verbatim: Hypertext.isolate(r.label ?? "")).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            }
        }
        .buttonStyle(.plain).disabled(off).opacity(off || wait ? 0.5 : 1)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A choice: a list of radios or check boxes (also a set shown as a menu, as on the web), a row of buttons, or a menu.
private struct HypertextChoice: View {
    let node: Hypertext.Node
    let r: Hypertext.Resolved
    /// Bound to a set: several options can be on.
    let multi: Bool
    let off: Bool
    let wait: Bool
    let fire: (String, Hypertext.Action) -> Void
    private var options: [Hypertext.ResolvedOption] { r.options ?? [] }
    private func pick(_ o: Hypertext.ResolvedOption) { if !wait { fire(node.id ?? "", .select(o.value)) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let label = r.label { Text(verbatim: Hypertext.isolate(label)).font(.caption.weight(.semibold)).fixedSize(horizontal: false, vertical: true) }
            if node.display == "buttons" {
                HypertextFlow(spacing: 4) { ForEach(options, id: \.value) { segment($0) } }
            } else if node.display == "menu" && !multi {
                menu
            } else {
                ForEach(options, id: \.value) { row($0) }
            }
        }
    }
    private func segment(_ o: Hypertext.ResolvedOption) -> some View {
        Button { pick(o) } label: {
            Text(verbatim: Hypertext.isolate(o.label)).font(.subheadline.weight(o.selected ? .semibold : .regular)).multilineTextAlignment(.leading)
                .padding(.horizontal, 11).padding(.vertical, 5)
                .background(o.selected ? accent.opacity(0.22) : Color.white.opacity(0.06), in: Capsule())
                .overlay(Capsule().stroke(o.selected ? accent : Color.white.opacity(0.15)))
        }
        .buttonStyle(.plain).disabled(off || o.disabled).opacity(off || o.disabled || wait ? 0.5 : 1)
        .accessibilityAddTraits(o.selected ? .isSelected : [])
    }
    private var menu: some View {
        Menu {
            ForEach(options, id: \.value) { o in
                Button { pick(o) } label: {
                    if o.selected { Label(Hypertext.isolate(o.label), systemImage: "checkmark") } else { Text(verbatim: Hypertext.isolate(o.label)) }
                }.disabled(o.disabled)
            }
        } label: {
            HStack(spacing: 6) {
                Text(verbatim: options.first(where: \.selected).map { Hypertext.isolate($0.label) } ?? tr(Hypertext.Sentence.choose)).lineLimit(2)
                Image(systemName: "chevron.up.chevron.down").font(.caption)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        }
        .disabled(off).opacity(off || wait ? 0.5 : 1)
    }
    private func row(_ o: Hypertext.ResolvedOption) -> some View {
        Button { pick(o) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: multi ? (o.selected ? "checkmark.square.fill" : "square") : (o.selected ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(off || o.disabled ? Color.secondary : accent)
                Text(verbatim: Hypertext.isolate(o.label)).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            }
        }
        .buttonStyle(.plain).disabled(off || o.disabled).opacity(off || o.disabled || wait ? 0.5 : 1)
        .accessibilityAddTraits(o.selected ? .isSelected : [])
    }
}

/// A text input. What is typed stays here until it is committed (leaving the field: saved, no handler runs) or
/// submitted (the button, or Return once any IME composition is done: its handler runs).
private struct HypertextInput: View {
    let node: Hypertext.Node
    let r: Hypertext.Resolved
    /// The declared `max` in code points.
    let max: Int
    let off: Bool
    let wait: Bool
    let fire: (String, Hypertext.Action) -> Void
    @State private var draft: String
    @FocusState private var focused: Bool
    init(node: Hypertext.Node, r: Hypertext.Resolved, max: Int, off: Bool, wait: Bool, fire: @escaping (String, Hypertext.Action) -> Void) {
        self.node = node; self.r = r; self.max = max; self.off = off; self.wait = wait; self.fire = fire
        _draft = State(initialValue: r.value?.string ?? "")
    }
    private var value: String { r.value?.string ?? "" }
    private var tooLong: Bool { Hypertext.cpLength(draft) > max }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let label = r.label { Text(verbatim: Hypertext.isolate(label)).font(.caption.weight(.semibold)).fixedSize(horizontal: false, vertical: true) }
            HStack(spacing: 6) {
                TextField(node.placeholder ?? "", text: $draft)
                    .textFieldStyle(.roundedBorder).focused($focused).submitLabel(.send).onSubmit(submit).disabled(off)
                Button(action: submit) { Text(verbatim: node.submitLabel.map(Hypertext.isolate) ?? tr(Hypertext.Sentence.send)) }
                    .buttonStyle(.bordered).disabled(off || tooLong).opacity(wait ? 0.5 : 1)
            }
            if tooLong {
                Text(verbatim: Hypertext.fill(tr(Hypertext.Sentence.atMost), ["n": String(max)], isolated: false)).font(.caption2).foregroundStyle(danger)
            }
            Text(tr(Hypertext.Sentence.inputNotice)).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        // The server's copy shows unless the viewer is typing.
        .onChange(of: value) { _, newValue in if !focused { draft = newValue } }
        .onChange(of: focused) { was, now in if was && !now { commit() } }
    }
    private func submit() { guard !off, !wait, !tooLong else { return }; fire(node.id ?? "", .submit(draft)) }
    private func commit() { guard !off, !tooLong, !Hypertext.same(draft, value) else { return }; fire(node.id ?? "", .commit(draft)) }
}

private struct HypertextButton: View {
    let node: Hypertext.Node
    let r: Hypertext.Resolved
    let off: Bool
    let wait: Bool
    let fire: (String, Hypertext.Action) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            styled.disabled(off).opacity(wait ? 0.5 : 1)
            // An out-of-character line is posted under the account's name, not the character's: the caption says so.
            if let caption = r.caption {
                (Text(tr(node.act?.sayKind == .ooc ? Hypertext.Sentence.postsOoc : Hypertext.Sentence.posts) + " ")
                    + Text(verbatim: Hypertext.isolate(caption)).font(.caption.monospaced()).foregroundColor(.primary))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    private var button: some View {
        Button { if !wait { fire(node.id ?? "", .click) } } label: {
            Text(verbatim: Hypertext.isolate(r.label ?? "")).multilineTextAlignment(.leading).foregroundStyle(node.style == "primary" ? ink : .primary)
        }
    }
    @ViewBuilder private var styled: some View {
        switch node.style {
        case "danger": button.buttonStyle(.bordered).tint(danger)
        case "secondary": button.buttonStyle(.bordered)
        default: button.buttonStyle(.borderedProminent)
        }
    }
}

/// A card's row: its children side by side, wrapping onto new lines as the web's wrapping flex row does.
private struct HypertextFlow: Layout {
    var spacing: CGFloat = 8
    private struct Line { var items: [(index: Int, size: CGSize)] = []; var width: CGFloat = 0; var height: CGFloat = 0 }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let lines = arrange(proposal.width, subviews)
        let width = lines.map(\.width).max() ?? 0
        let height = lines.map(\.height).reduce(0, +) + spacing * CGFloat(Swift.max(0, lines.count - 1))
        return CGSize(width: proposal.width.map { Swift.min($0, width) } ?? width, height: height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for item in line.items {
                subviews[item.index].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(item.size))
                x += item.size.width + spacing
            }
            y += line.height + spacing
        }
    }
    private func arrange(_ width: CGFloat?, _ subviews: Subviews) -> [Line] {
        var lines: [Line] = [], line = Line()
        for index in subviews.indices {
            var size = subviews[index].sizeThatFits(.unspecified)
            if let width, size.width > width { size = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil)) }
            if let width, !line.items.isEmpty, line.width + spacing + size.width > width { lines.append(line); line = Line() }
            line.width = line.items.isEmpty ? size.width : line.width + spacing + size.width
            line.height = Swift.max(line.height, size.height)
            line.items.append((index: index, size: size))
        }
        if !line.items.isEmpty { lines.append(line) }
        return lines
    }
}
