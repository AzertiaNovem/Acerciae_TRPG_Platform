import SwiftUI
import AcerciaeCore

struct PbtaSheetEditor: View {
    @ObservedObject var model: AppModel
    @Binding var card: [String: JSONValue]
    let rules: JSONValue
    let characterId: String
    let editable: Bool
    let dirty: Bool
    @State private var modifier = 0
    @State private var status = ""
    @State private var acting = false
    private var pack: JSONValue { rules["pack"] }
    private var sheet: JSONValue { card["pbta"] ?? .object([:]) }
    private var window: Resource? { model.windows.first { $0.id == model.windowId } }
    private var canSpeak: Bool { window != nil && (model.gm || window?["members"].array.contains(where: { $0["user_id"].text == model.session?.user.id }) == true) }
    var body: some View {
        Section(pack["name"].text + " · PbtA") {
            Picker(tr("Playbook"), selection: Binding(get: { sheet["book"].text }, set: { set("book", .string($0)) })) {
                Text(tr("Choose a playbook")).tag("")
                ForEach(pack["books"].array, id: \.id) { book in Text(book.name).tag(book.id) }
            }.disabled(!editable)
        }
        ForEach(["stats", "resources", "conditions"], id: \.self) { group in
            Section(tr(group == "stats" ? "Stats" : group == "resources" ? "Resources and experience" : "Conditions")) {
                ForEach(pack[group].array, id: \.id) { definition in
                    if group == "conditions" {
                        Toggle(definition.name, isOn: Binding(get: { sheet[group][definition.id].bool }, set: { value in var values = sheet[group].object; if value { values[definition.id] = .bool(true) } else { values.removeValue(forKey: definition.id) }; set(group, .object(values)) })).disabled(!editable)
                    } else {
                        LabeledContent(definition.name) {
                            TextField("0", text: number(group, definition.id)).keyboardType(.numbersAndPunctuation).multilineTextAlignment(.trailing)
                        }.disabled(!editable)
                    }
                }
            }
        }
        Section(tr("Moves")) {
            if editable { Stepper(tr("Move modifier") + " · \(modifier)", value: $modifier, in: -99...99) }
            if dirty { Text(tr("Save the sheet to use a move.")).font(.caption) }
            ForEach(Pbta.moves(pack: pack, sheet: sheet), id: \.id) { move in
                DisclosureGroup(move.name) {
                    Text(move["trigger"].text).textSelection(.enabled)
                    if !move["stat"].text.isEmpty {
                        Text("2d6 + " + (pack["stats"].array.first { $0.id == move["stat"].text }?.name ?? move["stat"].text) + " (\(sheet["stats"][move["stat"].text].int))").font(.caption)
                        ForEach(pack["bands"].array, id: \.id) { band in Text(band.name + " · " + move["outcomes"][band.id].text).font(.caption) }
                    }
                    if editable {
                        Button(tr(move["stat"].text.isEmpty ? "Use move" : "Roll dice") + " · " + (window?.name ?? tr("Choose a chat window"))) { Task { await perform(move) } }
                            .disabled(dirty || acting || !canSpeak || !model.enabled("dice") || !Pbta.validSheet(sheet, pack: pack))
                    }
                }
            }
            if !status.isEmpty { Text(status).textSelection(.enabled) }
        }
        if !pack["gmMoves"].array.isEmpty {
            DisclosureGroup(tr("GM reference moves")) { ForEach(pack["gmMoves"].array, id: \.id) { move in Text(move.name + " · " + move["text"].text) } }
        }
    }
    private func set(_ key: String, _ value: JSONValue) { var s = sheet.object; s[key] = value; card["pbta"] = .object(s) }
    private func number(_ group: String, _ id: String) -> Binding<String> {
        Binding(get: { let v = sheet[group][id]; return v.string ?? (v == .null ? "" : String(v.int)) }, set: { text in
            var values = sheet[group].object
            if text.isEmpty { values.removeValue(forKey: id) } else if let n = Int(text), (-9999...9999).contains(n) { values[id] = .number(Double(n)) } else { values[id] = .string(text) }
            set(group, .object(values))
        })
    }
    private func perform(_ move: JSONValue) async {
        guard !dirty, canSpeak, editable, !acting else { return }
        acting = true; defer { acting = false }
        let channel = model.channelId, windowId = model.windowId, scope = model.scopeKey
        do {
            let result = try await model.get(["channels",channel,"windows",windowId,"messages"], body: Pbta.moveBody(character: characterId, move: move, modifier: modifier))
            guard scope == model.scopeKey else { return }
            status = result["dice"]["text"].string ?? tr("Sent to {window}").replacingOccurrences(of: "{window}", with: window?.name ?? "")
            try await model.refresh()
        } catch { if scope == model.scopeKey { status = error.localizedDescription } }
    }
}

struct PbtaRulesView: View {
    @ObservedObject var model: AppModel
    @Environment(\.scenePhase) private var phase
    @State private var rules: JSONValue = .null
    @State private var review: JSONValue = .null
    @State private var pack: JSONValue = .null
    @State private var dirty = false
    @State private var compared = false
    @State private var reload = false
    @State private var status = ""
    private var base: [String] { ["channels",model.channelId,"pbta"] }
    private var pending: Bool { review["status"].text == "pending" }
    var body: some View {
        Form {
            if model.gm {
                if pack == .null { ProgressView(); Button(tr("Reload rules")) { Task { await load() } } }
                else {
                    Section(tr("Rule pack")) { TextField(tr("Name"), text: field("name")); Text("v\(rules["revision"].int) · PbtA").font(.caption) }
                    if ["designing","failed","retry","pending"].contains(review["status"].text) {
                        Section(tr("World rule draft")) {
                            if review["status"].text == "designing" { Text(tr("Design in progress")) }
                            if review["status"].text == "retry" { Text(tr("Run setup again for this channel.")) }
                            if !review["error"].text.isEmpty { Text(review["error"].text) }
                            ForEach(Array(review["reasons"].array.enumerated()), id: \.offset) { _, reason in Text(reason.text) }
                            if pending {
                                DisclosureGroup(tr("Compare current rules")) { PbtaPackSummary(pack: rules["pack"]) }
                                if review["base_revision"] != rules["revision"] { Toggle(tr("I compared the newer official rules"), isOn: $compared) }
                                Button(tr("Activate draft")) { Task { await decision("activate") } }.disabled(review["base_revision"] != rules["revision"] && !compared)
                            }
                            if ["designing","failed"].contains(review["status"].text) { Button(tr("Retry design")) { Task { await decision("retry") } } }
                            Button(tr("Keep current rules")) { Task { await decision("keep") } }
                        }
                    }
                    ForEach(PbtaPackSummary.groups, id: \.0) { group in
                        Section(tr(group.1)) {
                            ForEach(Array(pack[group.0].array.enumerated()), id: \.offset) { index, entry in
                                NavigationLink(entry.name) { PbtaRuleEntry(pack: Binding(get: { pack }, set: { pack = $0; dirty = true }), group: group.0, index: index) }
                            }
                            if group.0 != "bands" { Button(tr("Add")) { add(group.0) } }
                        }
                    }
                    Button(tr(pending ? "Save draft" : "Save rule pack")) { Task { await save() } }.disabled(!dirty)
                    Button(tr("Reload saved version")) { if dirty { reload = true } else { Task { await load() } } }
                }
                if !status.isEmpty { Text(status).textSelection(.enabled) }
            } else { Text(tr("仅当前频道的 GM 可访问")) }
        }.navigationTitle(tr("Rule pack")).disabled(model.busy)
            .confirmationDialog(tr("Discard draft and reload character card?"), isPresented: $reload) { Button(tr("Reload saved version"), role: .destructive) { Task { await load(force: true) } } }
            .task(id: model.scopeKey + "|" + String(describing: phase)) {
                guard model.gm, phase == .active else { return }
                if !dirty {
                    if let kept: JSONValue = await model.cached(base) { rules = kept; pack = kept["pack"] }
                    await load()
                }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(8)) } catch { return }
                    if phase == .active && !dirty && !model.busy && !["active","kept","none"].contains(review["status"].text) { await load() }
                }
            }
    }
    private func show(_ saved: JSONValue, _ draft: JSONValue) { rules = saved; review = draft; pack = draft["status"].text == "pending" ? draft["pack"] : saved["pack"]; dirty = false; compared = false }
    private func load(force: Bool = false) async { do { async let saved = model.get(base); async let draft = model.get(base + ["draft"]); let values = try await (saved,draft); guard force || !dirty else { status = tr("Reload saved version"); return }; show(values.0, values.1); status = "" } catch { status = error.localizedDescription } }
    private func field(_ key: String) -> Binding<String> { Binding(get: { pack[key].text }, set: { value in var p = pack.object; p[key] = .string(value); pack = .object(p); dirty = true }) }
    private func add(_ group: String) {
        let id = group.lowercased() + "_" + UUID().uuidString.prefix(8).lowercased()
        var entry: [String: JSONValue] = ["id":.string(id),"name":.string(tr("New entry"))]
        if group == "moves" { entry.merge(["book":.string(""),"stat":.string(""),"trigger":.string(""),"outcomes":.object(Dictionary(uniqueKeysWithValues: pack["bands"].array.map { ($0.id,.string("")) }))]) { _, new in new } }
        if group == "gmMoves" { entry["text"] = .string("") }
        var p = pack.object; p[group] = .array(pack[group].array + [.object(entry)]); pack = .object(p); dirty = true
    }
    private func decision(_ op: String) async {
        await model.run {
            _ = try await model.get(base + ["draft"], body: .object(["op":.string(op),"version":review["version"],"revision":rules["revision"],"reviewed_changes":.bool(compared),"pack":pack]))
            await load(force: true)
        }
    }
    private func save() async {
        if pending { await decision("edit") }
        else { await model.run { let saved = try await model.get(base, body: .object(["revision":rules["revision"],"pack":pack]), method:"PUT"); show(saved,review); status = tr("Rule pack saved") } }
    }
}

private struct PbtaPackSummary: View {
    static let groups = [("stats","Stats"),("books","Playbooks"),("resources","Resources and experience"),("conditions","Conditions"),("bands","Outcome bands"),("moves","Player moves"),("gmMoves","GM reference moves")]
    let pack: JSONValue
    var body: some View { ForEach(Self.groups, id: \.0) { group in DisclosureGroup(tr(group.1)) { ForEach(pack[group.0].array, id: \.id) { row in VStack(alignment:.leading) { Text(row.name); if group.0 == "moves" { Text(row["trigger"].text); ForEach(pack["bands"].array,id:\.id) { band in Text(band.name + " · " + row["outcomes"][band.id].text).font(.caption) } }; if group.0 == "gmMoves" { Text(row["text"].text) } } } } } }
}
private struct PbtaRuleEntry: View {
    @Binding var pack: JSONValue
    let group: String
    let index: Int
    @Environment(\.dismiss) private var dismiss
    private var entry: JSONValue { pack[group].array.indices.contains(index) ? pack[group].array[index] : .null }
    var body: some View {
        Form {
            TextField(tr("Name"), text: text("name"))
            TextField("ID", text: text("id")).textInputAutocapitalization(.never).autocorrectionDisabled()
            if group == "bands" { TextField(tr("Minimum"), text: number("min")).keyboardType(.numbersAndPunctuation); TextField(tr("Maximum"), text: number("max")).keyboardType(.numbersAndPunctuation) }
            if group == "gmMoves" { TextField(tr("Text"), text: text("text"), axis:.vertical) }
            if group == "moves" {
                TextField(tr("Trigger"), text: text("trigger"), axis:.vertical)
                Picker(tr("Playbook"), selection: text("book")) { Text(tr("All")).tag(""); ForEach(pack["books"].array,id:\.id) { Text($0.name).tag($0.id) } }
                Picker(tr("Stat"), selection: text("stat")) { Text(tr("Diceless")).tag(""); ForEach(pack["stats"].array,id:\.id) { Text($0.name).tag($0.id) } }
                ForEach(pack["bands"].array,id:\.id) { band in
                    TextField(band.name, text: Binding(get: { entry["outcomes"][band.id].text }, set: { value in var o = entry["outcomes"].object; o[band.id] = .string(value); set("outcomes",.object(o)) }), axis:.vertical)
                }
                ForEach(entry["stat"].text.isEmpty ? [JSONValue.object(["id":.string("no_roll"),"name":.string(tr("Diceless"))])] : pack["bands"].array,id:\.id) { band in
                    Toggle(band.name + " · " + tr("Player choice"), isOn: Binding(get: { entry["playerChoiceBands"].array.contains(.string(band.id)) }, set: { on in var a = entry["playerChoiceBands"].array.filter { $0 != .string(band.id) }; if on { a.append(.string(band.id)) }; set("playerChoiceBands",.array(a)) }))
                }
            }
            if group != "bands" { Button(tr("Delete"), role:.destructive) { var p = pack.object; var a = pack[group].array; guard a.indices.contains(index) else { return }; a.remove(at:index); p[group] = .array(a); pack = .object(p); dismiss() } }
        }.navigationTitle(entry.name)
    }
    private func set(_ key: String, _ value: JSONValue) { var p = pack.object; var a = pack[group].array; guard a.indices.contains(index) else { return }; var row = a[index].object; row[key] = value; a[index] = .object(row); p[group] = .array(a); pack = .object(p) }
    private func text(_ key: String) -> Binding<String> { Binding(get: { entry[key].text }, set: { set(key,.string($0)) }) }
    private func number(_ key: String) -> Binding<String> { Binding(get: { entry[key].string ?? (entry[key] == .null ? "" : String(entry[key].int)) }, set: { if $0.isEmpty { set(key,.null) } else if let n = Int($0) { set(key,.number(Double(n))) } else { set(key,.string($0)) } }) }
}
