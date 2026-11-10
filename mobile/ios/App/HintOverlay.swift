import SwiftUI
import AcerciaeCore

struct AssistanceOverlay: View {
    @ObservedObject var model: AppModel
    var body: some View {
        if model.resultType == "inspiration" && model.inspiration != .null {
            // A new result (another take) starts from its own first option.
            InspirationOverlay(model: model, result: model.inspiration).id(model.inspiration["id"].text)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(tr("一致性检查")).font(.headline)
                    Spacer()
                    Button(tr("关闭")) { model.result = nil }
                }
                ScrollView { Text(model.result ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            }.padding(16)
        }
    }
}

/// The ways the character might play the moment, in their own voice: pick one, edit it, insert it (or the roll that
/// goes with it). Nothing is sent for the player. "Another take" asks for three different ones.
private struct InspirationOverlay: View {
    @ObservedObject var model: AppModel
    let result: JSONValue
    private let options: [InspirationOption]
    @State private var picked = 0
    @State private var text: String
    init(model: AppModel, result: JSONValue) {
        self.model = model
        self.result = result
        let options = Inspiration.options(result)
        self.options = options
        _text = State(initialValue: options.first?.text ?? "")
    }
    private var roll: String { options.indices.contains(picked) ? options[picked].roll : "" }
    private var footnote: String {
        var note = result["notes"].text
        if note.isEmpty { note = tr("Uses only what your character knows; it proposes, it does not decide outcomes.") }
        let facts = result["used_fact_ids"].array.count
        if facts > 0 { note += " · " + tr("grounded in {n} known facts").replacingOccurrences(of: "{n}", with: String(facts)) }
        if result["llm_mode"].text == "mock" { note += " · " + tr("mock LLM") }
        return note
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("✦ " + tr("灵感")).font(.headline)
                Spacer()
                Button(tr("关闭")) { model.result = nil }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text(tr("Three ways to play the moment, in your character's voice. Pick one, edit it if you like, then insert it; nothing is sent for you.")).font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(options.enumerated()), id: \.offset) { index, option in card(index, option) }
                    TextField("", text: $text, axis: .vertical).lineLimit(2...6).padding(8)
                        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                    Text(footnote).font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { actions }
                VStack(alignment: .leading, spacing: 8) { actions }
            }
            Text(tr("Editable · not sent")).font(.caption).foregroundStyle(.secondary)
        }.padding(16)
    }
    private func caption(_ index: Int, _ option: InspirationOption) -> String {
        var parts: [String] = []
        parts.append(option.angle.isEmpty ? tr("Option {n}").replacingOccurrences(of: "{n}", with: String(index + 1)) : option.angle)
        if option.kind == "ooc" { parts.append("OOC") }
        if !option.roll.isEmpty { parts.append(option.roll) }
        return parts.joined(separator: " · ")
    }
    private func card(_ index: Int, _ option: InspirationOption) -> some View {
        let on = index == picked
        return Button { picked = index; text = option.text } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(caption(index, option)).font(.caption.bold()).foregroundStyle(.tint)
                Text(option.text).font(.subheadline).multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(Color.white.opacity(on ? 0.14 : 0.06), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(on ? 0.55 : 0)))
        }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
    }
    @ViewBuilder private var actions: some View {
        Button(tr("Insert into input")) { model.adopt(text) }
            .buttonStyle(.borderedProminent).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        // The roll goes in after the line: send the line first, then the roll.
        if !roll.isEmpty { Button(tr("Insert the roll") + " " + roll) { model.adopt(roll) }.buttonStyle(.bordered) }
        Button(tr(model.busy ? "Drafting…" : "Another take")) { Task { await model.anotherTake() } }.disabled(model.busy)
    }
}

// Lives in the chat's overlay, including all drill-downs. Players never fetch the GM board or documents.
struct HintOverlay: View {
    @ObservedObject var model: AppModel
    let close: () -> Void
    @State private var selection = ""
    @State private var data: JSONValue = .null
    @State private var board: JSONValue = .null
    @State private var error = ""
    @State private var loading = false
    @Environment(\.scenePhase) private var phase
    private var reminder: Resource? { model.reminders.first { selection == "r:" + $0.id } }
    private var document: DocumentSummary? { model.campaign?.documents.first { selection == "d:" + $0.id } }
    private var revision: String { selection + ":" + String(reminder?["version"].int ?? document?.version ?? 0) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                if !selection.isEmpty { Button { selection = "" } label: { Image(systemName: "chevron.left") }.accessibilityLabel(tr("Back")) }
                Text(tr("提示")).font(.headline)
                Spacer()
                Button(tr("关闭"), action: close)
            }.padding(.horizontal, 16).padding(.top, 14)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !error.isEmpty { Text(error).foregroundStyle(.red); Button(tr("Retry")) { Task { await load() } } }
                    if selection.isEmpty { cards }
                    else if selection == "world" { WorldRecord(model: model).id(model.scopeKey) }
                    else if selection == "next" || selection == "notes" { KeeperHintBody(board: board, slot: selection) }
                    else if loading { ProgressView() }
                    else if let reminder { reminderBody(reminder) }
                    else if let document { documentBody(document) }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }
        }
        .task(id: revision) { await load() }
        .task(id: phase) {
            guard model.gm, phase == .active else { return }
            while !Task.isCancelled {
                do { let value = try await model.get(["channels", model.channelId, "kp", "board"]); try Task.checkCancellation(); board = value }
                catch { if !Task.isCancelled { self.error = error.localizedDescription } }
                do { try await Task.sleep(for: .seconds(4)) } catch { break }
            }
        }
    }
    private var cards: some View {
        Group {
            card(tr("World record"), tr("What is true now"), "world")
            if model.gm {
                card(tr("Next per the script"), board["next"]["has_script"].bool ? board["next"]["next"]["title"].text : tr("No module imported yet."), "next")
                card(tr("Notes"), board["notes"]["open_threads"].array.first?["summary"].text ?? tr("Open threads, timeline and reviewed changes."), "notes")
            }
            if model.reminders.isEmpty && !model.gm { Text(tr("Nothing to remind you of yet.")).foregroundStyle(.secondary) }
            ForEach(model.reminders) { r in
                // A pinned line is its own quote: the card says who pinned it instead of repeating it.
                if r["kind"].text == "pinned" { card("📌 " + r.name, pinnedBy(r), "r:" + r.id) }
                else { card(r.name + " · " + tr(kind(r["kind"].text)), r["citations"].array.first?["quotes"].array.first?.text ?? r["why"].text, "r:" + r.id) }
            }
            if model.gm {
                ForEach(model.campaign?.documents ?? []) { d in
                    let count = model.campaign?.highlights.filter { $0.documentId == d.id }.count ?? 0
                    card(tr(d.title) + " · v\(d.version)" + (count > 0 ? " · \(count) " + tr("active highlights") : ""), d.preview ?? "", "d:" + d.id)
                }
            }
        }
    }
    private func kind(_ kind: String) -> String { kind == "needed" ? "still open" : kind == "plan" ? "plan" : kind == "note" ? "note" : kind == "pinned" ? "pinned" : "you may have forgotten" }
    private func pinnedBy(_ r: Resource) -> String { tr("pinned by {name}").replacingOccurrences(of: "{name}", with: r["pinned_by_name"].text) }
    private func footer(_ r: Resource, pinned: Bool) -> String {
        if pinned { return tr("This line was pinned by {name}; the AI keeps it in mind too.").replacingOccurrences(of: "{name}", with: r["pinned_by_name"].text) }
        return tr("The highlighted passages are quoted verbatim from the chat; the note above is the AI reminder about them.")
    }
    private func card(_ title: String, _ preview: String, _ id: String) -> some View {
        Button { selection = id } label: {
            VStack(alignment: .leading, spacing: 6) { Text(title).font(.subheadline.bold()); Text(preview).font(.caption).lineLimit(3).foregroundStyle(.secondary) }
                .frame(maxWidth: .infinity, alignment: .leading).padding(12).background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
        }.buttonStyle(.plain)
    }
    @ViewBuilder private func reminderBody(_ r: Resource) -> some View {
        let pinned = r["kind"].text == "pinned"
        Text((pinned ? "📌 " : "") + r.name).font(.headline); Text(pinned ? pinnedBy(r) : r["why"].text)
        if r["llm_mode"].text == "mock" { Text(tr("mock LLM")).font(.caption) }
        ForEach(Array(r["script_refs"].array.enumerated()), id: \.offset) { _, ref in
            VStack(alignment: .leading) { Text(tr("From the script") + " · " + ref["title"].text); Text(tr("Page") + " \(ref["page"].int) · " + ref["excerpt"].text).font(.caption) }
        }
        if data["reminder"]["version"] == r["version"] {
            ForEach(Array(data["events"].array.enumerated()), id: \.offset) { _, event in HintEvent(model: model, event: event, close: close) }
        }
        Text(footer(r, pinned: pinned)).font(.caption).foregroundStyle(.secondary)
        if !pinned {
            Button(tr("Dismiss")) { Task { await model.run {
                _ = try await model.get(["channels", model.channelId, "reminders", r.id, "dismiss"], body: .object([:])); try await model.refresh(); selection = ""
            } } }.disabled(model.busy)
        } else if Pins.canUnpin(r, userId: model.session?.user.id, gm: model.gm) {
            Button(tr("Unpin")) { Task { await model.unpin(r.id); selection = "" } }.disabled(model.busy)
        }
    }
    @ViewBuilder private func documentBody(_ d: DocumentSummary) -> some View {
        Text(tr(d.title) + " · v\(d.version)").font(.headline)
        if data["entries"].array.isEmpty { Text(tr("Nothing recorded yet")) }
        ForEach(Array(data["entries"].array.enumerated()), id: \.offset) { _, entry in
            VStack(alignment: .leading, spacing: 6) {
                let highlights = model.campaign?.highlights.filter { $0.targetEntryId == entry["id"].text } ?? []
                Text((try? AttributedString(markdown: entry["content_md"].string ?? entry["summary"].text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(entry["summary"].text)).textSelection(.enabled).padding(6).background(highlights.isEmpty ? .clear : .yellow.opacity(0.2))
                Text(tr(entry["status"].text) + " · " + entry["scene_title"].text + " · v\(entry["updated_version"].int)").font(.caption).foregroundStyle(.secondary)
                ForEach(highlights) { h in Text(h.reason).font(.caption).foregroundStyle(.yellow) }
                HintSources(model: model, ids: entry["source_event_ids"].array.map(\.text), close: close)
            }
        }
    }
    @MainActor private func load() async {
        data = .null; error = ""; loading = true; defer { loading = false }
        do {
            let value: JSONValue
            if let reminder { value = try await model.get(["channels", model.channelId, "reminders", reminder.id, "context"]) }
            else if let document, model.gm {
                let scene = model.windows.first { $0.id == model.windowId }?["active_scene_id"].text ?? ""
                value = try await model.get(["channels", model.channelId, "documents", document.id], query: scene.isEmpty ? [:] : ["scene_id": scene])
            } else { if selection.hasPrefix("r:") || selection.hasPrefix("d:") { selection = "" }; return }
            try Task.checkCancellation(); data = value
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct HintEvent: View {
    @ObservedObject var model: AppModel
    let event: JSONValue
    let close: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text((event["character_name"].string ?? event["author_name"].text) + " · " + event["window_name"].text + " · " + event["created_at"].text).font(.caption).foregroundStyle(.secondary)
            Text(quoted).textSelection(.enabled)
            if !event["message_id"].text.isEmpty {
                ViewThatFits { HStack { actions }; VStack(alignment: .leading) { actions } }
            }
        }.padding(10).background(event["cited"].bool ? .yellow.opacity(0.08) : .white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }
    private var actions: some View {
        Group {
            Button(tr("jump to message ↗")) { Task { await model.run { try await model.openEvidence(event, quote: false); close() } } }
            Button(tr("Quote as reference")) { Task { await model.run { try await model.openEvidence(event, quote: true); close() } } }
        }.font(.caption).disabled(model.busy)
    }
    private var quoted: AttributedString {
        let text = event["content"].string ?? event["payload"]["content"].string ?? event["payload"].pretty
        let result = NSMutableAttributedString(string: text)
        for quote in event["quotes"].array.map(\.text).filter({ !$0.isEmpty }) {
            if let regex = try? NSRegularExpression(pattern: NSRegularExpression.escapedPattern(for: quote)) {
                for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) { result.addAttribute(.backgroundColor, value: UIColor.yellow.withAlphaComponent(0.25), range: match.range) }
            }
        }
        return AttributedString(result)
    }
}
private struct HintSources: View {
    @ObservedObject var model: AppModel
    let ids: [String]
    let close: () -> Void
    @State private var expanded = false
    @State private var events: [Resource] = []
    @State private var error = ""
    var body: some View {
        if !ids.isEmpty {
            DisclosureGroup(tr("Source"), isExpanded: $expanded) {
                if !error.isEmpty { Text(error) }
                ForEach(events) { event in HintEvent(model: model, event: event.value, close: close) }
            }.task(id: expanded) {
                guard expanded else { return }
                do { let rows: [Resource] = try await model.typed(["channels", model.channelId, "events"], query: ["ids": ids.joined(separator: ",")]); try Task.checkCancellation(); events = rows }
                catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
        }
    }
}
private struct KeeperHintBody: View {
    let board: JSONValue
    let slot: String
    var body: some View {
        let next = board["next"]
        let notes = board["notes"]
        if slot == "next" {
            Text(tr("Next per the script")).font(.headline)
            if !next["has_script"].bool { Text(tr("No module imported yet. Import the script in the GM workspace to see what it plans next.")) }
            else {
                Text(next["summary"].text)
                Text(tr("Now") + ": " + next["current"]["title"].text)
                Text(tr("Next") + ": " + next["next"]["title"].text).font(.headline)
                Text(next["next"]["data"]["location"].text); Text(next["next"]["body"].text)
                strings("What the GM does there", next["next"]["data"]["keeper_actions"])
                strings("Needs first", next["next"]["data"]["prerequisites"])
                strings("Twists planted here", next["next"]["data"]["twists"])
                Text((next["next"]["citation"]["page"].int > 0 ? tr("Page") + " \(next["next"]["citation"]["page"].int) · " : "") + next["next"]["citation"]["excerpt"].text).font(.caption)
                rows("Still unrevealed", next["pending_clues"]); rows("Foreshadowing not yet paid off", next["pending_foreshadowing"])
                Text("\(next["stages_done"].int)/\(next["stages_total"].int) " + tr("stages done")).font(.caption)
            }
        } else {
            Text(tr("GM's notes")).font(.headline)
            rows("Open threads", notes["open_threads"]); rows("Timeline", notes["timeline"]); rows("Script stages played", notes["stages_done"]); rows("Latest reviewed changes", notes["recent_changes"])
        }
    }
    @ViewBuilder private func strings(_ title: String, _ values: JSONValue) -> some View {
        if !values.array.isEmpty { Text(tr(title)).font(.subheadline.bold()); ForEach(Array(values.array.enumerated()), id: \.offset) { _, value in Text(value.text) } }
    }
    private func rows(_ title: String, _ values: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(tr(title)).font(.subheadline.bold())
            if values.array.isEmpty { Text(tr("None recorded.")).foregroundStyle(.secondary) }
            ForEach(Array(values.array.enumerated()), id: \.offset) { _, row in
                Text([row["summary"].string ?? row["title"].text, row["location"].text, row["narrative_time"].text, tr(row["status"].text), tr(row["verdict"].text), row["op"].text, row["reviewer_reason"].text].filter { !$0.isEmpty }.joined(separator: " · "))
            }
        }
    }
}
