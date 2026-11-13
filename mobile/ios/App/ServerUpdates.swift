import SwiftUI
import AcerciaeCore

struct ServerManagementView: View {
    @ObservedObject var model: AppModel
    let area: String
    @State private var draft: [String: JSONValue] = [:]
    @State private var invites: [Resource] = []
    @State private var channels: [Resource] = []
    @State private var uses = "10"
    @State private var hours = "168"
    @State private var doomed: Resource?
    @State private var deleteServer = false
    @State private var phrase = ""
    var body: some View {
        Form {
            if model.serverSettings["is_maintainer"].bool {
                if area == "Access" {
                    Section(tr("Access")) {
                        choice("policy", "join_policy", "How people join", [("invite", "With an invite link from a maintainer"), ("open", "Open: listed in the server directory, anyone may join"), ("closed", "Closed: only maintainers add members")])
                        choice("policy", "channel_creation", "Who may create channels", [("members", "Every member"), ("maintainers", "Maintainers only")])
                        Toggle(tr("Channel GMs may invite guests"), isOn: flag("policy", "guest_invites"))
                        Text(tr("A GM can invite people from outside the server. Guests see only the channels they were invited to and leave the server with their last channel.")).font(.caption)
                        Toggle(tr("Members may read other channels' Main Chat"), isOn: flag("policy", "main_chat_spectators"))
                        Text(tr("Members not invited to a channel can read its Main Chat, read-only: only lines everyone at that table sees. Guests never can.")).font(.caption)
                        save(["policy"])
                    }
                    Section(tr("Invite links")) {
                        LabeledContent(tr("Maximum uses")) { TextField(tr("Maximum uses"), text: $uses).keyboardType(.numberPad).multilineTextAlignment(.trailing) }
                        LabeledContent(tr("Expires in (hours)")) { TextField(tr("Expires in (hours)"), text: $hours).keyboardType(.numberPad).multilineTextAlignment(.trailing) }
                        Button(tr("Create link")) { Task { await model.run {
                            _ = try await model.get(["servers", model.serverId, "invites"], body: .object(["max_uses": .number(Double(uses) ?? 0), "expires_in_hours": .number(Double(hours) ?? 0)]))
                            try await loadInvites()
                        } } }.disabled(model.busy || Int(uses) == nil || Int(hours) == nil || !(0...10000).contains(Int(uses) ?? -1) || !(0...8760).contains(Int(hours) ?? -1) || model.serverSettings["policy"]["join_policy"].text == "closed")
                        ForEach(invites) { invite in
                            Text(invite["code"].text).textSelection(.enabled)
                            Text("\(invite["uses"].int) / \(invite["max_uses"].int) · \(invite["expires_at"].text)").font(.caption)
                            if invite["active"].bool { Button(tr("Revoke"), role: .destructive) { Task { await model.run {
                                _ = try await model.get(["servers", model.serverId, "invites", invite.id], body: nil, method: "DELETE"); try await loadInvites()
                            } } } } else { Text(tr("expired")).font(.caption) }
                        }
                    }
                } else if area == "AI" {
                    Text(tr("AI on this server runs only on the providers configured here, with this server's own keys. Without them it runs in mock mode.")).font(.caption)
                    AiProvidersSection(model: model)
                    Section(tr("AI policy")) {
                        ForEach(["token_budget", "image_budget", "max_concurrent"], id: \.self) { key in LabeledContent(tr(fieldName(key))) { TextField(tr(fieldName(key)), text: number("ai_policy", key)).keyboardType(.numberPad).multilineTextAlignment(.trailing) } }
                        choice("ai_policy", "period", "Budget period", [("month", "Each calendar month"), ("total", "Total")])
                        Text("\(tr("Tokens used")): \(model.serverSettings["ai_policy"]["tokens_used"].int) · \(tr("Cached tokens")): \(model.serverSettings["ai_policy"]["cached_tokens_used"].int) · \(tr("Images used")): \(model.serverSettings["ai_policy"]["images_used"].int)").font(.caption)
                    }
                    save(["ai_policy"])
                } else {
                    Section(tr("Channels")) {
                        ForEach(channels) { item in
                            HStack { Text(item.name); Spacer(); Button(tr("Delete channel"), role: .destructive) { doomed = item; phrase = "" } }
                        }
                    }
                    if model.serverRole == "owner" { Button(tr("Delete server"), role: .destructive) { deleteServer = true; phrase = "" } }
                }
            } else { Text(tr("Only server maintainers can change these settings.")) }
        }.navigationTitle(tr(area)).disabled(model.busy)
        .task {
            draft = model.serverSettings.object
            guard model.serverSettings["is_maintainer"].bool else { return }
            await model.run { if area == "Access" { try await loadInvites() }; if area == "Channels" { channels = try await model.typed(["servers", model.serverId, "all-channels"]) } }
        }
        .sheet(isPresented: Binding(get: { doomed != nil || deleteServer }, set: { if !$0 { doomed = nil; deleteServer = false } })) {
            NavigationStack {
                Form {
                    Text(deleteServer ? model.serverName : doomed?.name ?? "").font(.headline)
                    Text(tr(deleteServer ? "Every channel goes with it — chat, characters, documents, media and logs — for every member, and its invites stop working. This cannot be undone." : "Its chat, characters, documents, media, scenarios and logs are deleted for every member. This cannot be undone."))
                    Text(tr("Type {phrase} to confirm.").replacingOccurrences(of: "{phrase}", with: deleteServer ? "Delete Server" : "Delete Channel"))
                    TextField(deleteServer ? "Delete Server" : "Delete Channel", text: $phrase).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button(tr(deleteServer ? "Delete server" : "Delete channel"), role: .destructive) { Task { await model.run {
                        let path = deleteServer ? ["servers", model.serverId] : ["channels", doomed?.id ?? ""]
                        _ = try await model.get(path, body: .object(["confirm": .string(phrase)]), method: "DELETE")
                        doomed = nil; deleteServer = false; phrase = ""; try await model.refreshCatalog()
                        if model.serverSettings["is_maintainer"].bool { channels = try await model.typed(["servers", model.serverId, "all-channels"]) }
                    } } }.disabled(model.busy || phrase != (deleteServer ? "Delete Server" : "Delete Channel"))
                }.toolbar { Button(tr("Cancel")) { doomed = nil; deleteServer = false } }.interactiveDismissDisabled(model.busy)
            }
        }
    }
    private func loadInvites() async throws { invites = try await model.typed(["servers", model.serverId, "invites"]) }
    private func value(_ group: String, _ key: String) -> Binding<String> { Binding(get: { draft[group]?[key].text ?? "" }, set: { set(group, key, .string($0)) }) }
    private func number(_ group: String, _ key: String) -> Binding<String> { Binding(get: { String(draft[group]?[key].int ?? 0) }, set: { if let n = Double($0), n >= 0 { set(group, key, .number(n)) } }) }
    private func flag(_ group: String, _ key: String) -> Binding<Bool> { Binding(get: { draft[group]?[key].bool ?? false }, set: { set(group, key, .bool($0)) }) }
    private func set(_ group: String, _ key: String, _ value: JSONValue) { var v = draft[group]?.object ?? [:]; v[key] = value; draft[group] = .object(v) }
    private func choice(_ group: String, _ key: String, _ label: String, _ options: [(String,String)]) -> some View { Picker(tr(label), selection: value(group, key)) { ForEach(options, id: \.0) { Text(tr($0.1)).tag($0.0) } } }
    private func save(_ keys: [String]) -> some View {
        Button(tr("Save")) { Task { await model.run {
            // Send only writable provider fields; keys remain blank unless explicitly replaced.
            var body: [String: JSONValue] = [:]
            for key in keys { var fields = draft[key]?.object ?? [:]; fields.removeValue(forKey: "api_key_set"); fields.removeValue(forKey: "api_key_hint"); if key == "ai_policy" { fields = fields.filter { ["token_budget", "image_budget", "period", "max_concurrent"].contains($0.key) } }; body[key] = .object(fields) }
            model.serverSettings = try await model.get(["servers", model.serverId, "settings"], body: .object(body), method: "PUT")
            draft = model.serverSettings.object; model.notice = tr("Saved")
        } } }.disabled(model.busy)
    }
}
func fieldName(_ key: String) -> String { ["token_budget":"Token budget", "image_budget":"Image budget", "max_concurrent":"Simultaneous AI tasks"][key] ?? key }

/// Server options → AI: the server's providers (an endpoint of a known kind with its own keys) and the provider and
/// model of each use. A use only offers providers whose kind can do it. Same API and rules as the web.
struct AiProvidersSection: View {
    @ObservedObject var model: AppModel
    @State private var catalog: JSONValue = .null
    @State private var ai: JSONValue = .null
    @State private var uses: [String: JSONValue] = [:]
    @State private var editing: AiProviders.Draft?
    @State private var newKind = "openai"
    @State private var doomed: JSONValue?
    private var providers: [JSONValue] { ai["providers"].array }

    var body: some View {
        Group {
            if catalog == .null { Text(tr("Loading…")) } else { providerSection; usesSection }
        }
        .task(id: model.serverId) { await model.run { catalog = try await model.get(["ai", "catalog"]); try await reload() } }
        .confirmationDialog(tr("Delete provider “{name}”?").replacingOccurrences(of: "{name}", with: doomed?["name"].text ?? ""),
                            isPresented: Binding(get: { doomed != nil }, set: { if !$0 { doomed = nil } }), titleVisibility: .visible) {
            Button(tr("Delete"), role: .destructive) {
                let id = doomed?["id"].text ?? ""; doomed = nil
                Task { await model.run { ai = try await model.get(["servers", model.serverId, "ai", "providers", id], body: nil, method: "DELETE"); uses = ai["uses"].object; try await model.refreshCatalog() } }
            }
        } message: { Text(tr("The uses on it go back to their defaults.")) }
    }

    private func reload() async throws { ai = try await model.get(["servers", model.serverId, "ai"]); uses = ai["uses"].object }
    private func kindLabel(_ id: String) -> String { tr(AiProviders.kind(catalog, id)?["label"].text ?? id) }
    private func capabilityLabel(_ c: String) -> String { tr(AiProviders.uses(catalog).first { $0["capability"].text == c }?["label"].text ?? c) }
    private func useLabel(_ id: String) -> String { tr(AiProviders.uses(catalog).first { $0["id"].text == id }?["label"].text ?? id) }

    @ViewBuilder private var providerSection: some View {
        Section(tr("Providers")) {
            Text(tr("Add the AI services this server uses: each is an endpoint of a known kind with this server's own keys. You can change the endpoint of any of them.")).font(.caption)
            if providers.isEmpty { Text(tr("No providers yet: AI runs in mock mode.")) }
            ForEach(providers.indices, id: \.self) { i in
                let p = providers[i]
                let kind = AiProviders.kind(catalog, p["kind"].text)
                if editing?.id == p["id"].text, let kind { editor(kind: kind, stored: p) } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(p["name"].text + " · " + kindLabel(p["kind"].text)).font(.headline)
                        Text(p["api_base"].text.isEmpty ? (kind?["default_api_base"].text ?? "").replacingOccurrences(of: "{region}", with: p["options"]["region"].string ?? "us-east-1") : p["api_base"].text)
                            .font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                        Text(AiProviders.capabilities(kind).map(capabilityLabel).joined(separator: " · ")).font(.caption)
                        if !p["api_key_set"].bool { Text(tr("No key")).font(.caption).foregroundStyle(.red) }
                        let used = p["used_by"].array.compactMap(\.string)
                        if !used.isEmpty { Text(tr("Used for") + ": " + used.map(useLabel).joined(separator: ", ")).font(.caption) }
                        HStack {
                            Button(tr("Edit")) { if let kind { editing = AiProviders.draft(of: p, kind: kind) } }.buttonStyle(.borderless).disabled(editing != nil)
                            Spacer()
                            Button(tr("Delete"), role: .destructive) { doomed = p }.buttonStyle(.borderless)
                        }
                    }
                }
            }
            if let draft = editing, draft.id == nil, let kind = AiProviders.kind(catalog, draft.kind) { editor(kind: kind, stored: nil) }
            if editing == nil {
                Picker(tr("Provider"), selection: $newKind) { ForEach(AiProviders.kinds(catalog).map { $0["id"].text }, id: \.self) { Text(kindLabel($0)).tag($0) } }
                Text(tr("Can do") + ": " + AiProviders.capabilities(AiProviders.kind(catalog, newKind)).map(capabilityLabel).joined(separator: ", ")).font(.caption)
                Button(tr("Add provider")) { if let kind = AiProviders.kind(catalog, newKind) { editing = AiProviders.draft(of: nil, kind: kind, label: tr(kind["label"].text)) } }
            }
        }
    }

    private func text(_ get: @escaping (AiProviders.Draft) -> String, _ set: @escaping (inout AiProviders.Draft, String) -> Void) -> Binding<String> {
        Binding(get: { editing.map(get) ?? "" }, set: { value in if var d = editing { set(&d, value); editing = d } })
    }

    @ViewBuilder private func editor(kind: JSONValue, stored: JSONValue?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(kindLabel(kind["id"].text)).font(.headline)
            Text(tr(kind["protocol"].text)).font(.caption).foregroundStyle(.secondary)
            TextField(tr("Name"), text: text({ $0.name }, { $0.name = $1 }))
            TextField(kind["default_api_base"].text.isEmpty ? tr("Endpoint") : kind["default_api_base"].text, text: text({ $0.apiBase }, { $0.apiBase = $1 }))
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            if !kind["api_base_hint"].text.isEmpty { Text(tr(kind["api_base_hint"].text)).font(.caption) }
            ForEach(kind["fields"].array.indices, id: \.self) { i in
                let f = kind["fields"].array[i]
                let key = f["key"].text
                let label = tr(f["label"].text) + (f["required"].bool ? " *" : "")
                if f["type"].text != "secret" {
                    VStack(alignment: .leading) {
                        Text(label).font(.caption).foregroundStyle(.secondary)
                        TextField(f["placeholder"].text, text: text({ $0.options[key] ?? "" }, { $0.options[key] = $1 })).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                } else {
                    let main = key == "api_key"
                    let set = main ? stored?["api_key_set"].bool == true : stored?["secrets"][key]["set"].bool == true
                    let hint = main ? stored?["api_key_hint"].text ?? "" : stored?["secrets"][key]["hint"].text ?? ""
                    VStack(alignment: .leading) {
                        Text(label).font(.caption).foregroundStyle(.secondary)
                        SecureField(set ? tr("stored ({hint}) — type to replace").replacingOccurrences(of: "{hint}", with: hint) : tr(f["required"].bool ? "required" : "optional"),
                                    text: text({ main ? $0.apiKey : ($0.secrets[key] ?? "") }, { d, v in if main { d.apiKey = v; d.clearApiKey = false } else { d.secrets[key] = v; d.removedSecrets.remove(key) } }))
                        if set && !f["required"].bool {
                            Toggle(tr("Remove the stored key"), isOn: Binding(
                                get: { main ? editing?.clearApiKey == true : editing?.removedSecrets.contains(key) == true },
                                set: { on in if var d = editing { if main { d.clearApiKey = on; if on { d.apiKey = "" } } else if on { d.removedSecrets.insert(key); d.secrets[key] = nil } else { d.removedSecrets.remove(key) }; editing = d } }))
                        }
                    }
                }
            }
            if !kind["notes"].text.isEmpty { Text(tr(kind["notes"].text)).font(.caption) }
            HStack {
                Button(tr("Cancel")) { editing = nil }.buttonStyle(.borderless)
                Spacer()
                Button(tr("Save provider")) {
                    guard let d = editing else { return }
                    Task { await model.run {
                        let body = AiProviders.body(d)
                        if let id = d.id { _ = try await model.get(["servers", model.serverId, "ai", "providers", id], body: body, method: "PUT") }
                        else { _ = try await model.get(["servers", model.serverId, "ai", "providers"], body: body) }
                        try await reload(); editing = nil; model.notice = tr("Provider saved")
                    } }
                }.buttonStyle(.borderless).disabled(model.busy || editing.map { !AiProviders.ready($0, kind: kind, stored: stored) } ?? true)
            }
        }
    }

    private func optionLabel(_ key: String, _ value: String) -> String {
        if value.isEmpty { return tr("Thinking effort: off") }
        if value == "auto" { return tr("Provider default") }
        if key == "size" { return value }
        return tr(value.prefix(1).uppercased() + String(value.dropFirst()))
    }
    private func optionTitle(_ key: String) -> String { tr(key == "reasoning_effort" ? "Thinking effort" : key == "size" ? "Image size" : "Image quality") }
    private func current(_ use: JSONValue) -> JSONValue {
        uses[use["id"].text] ?? .object(["provider": .string(use["default"].text), "model": .string(""), "options": .object([:])])
    }
    private func update(_ id: String, _ change: (inout [String: JSONValue]) -> Void) { var o = uses[id]?.object ?? [:]; change(&o); uses[id] = .object(o) }

    @ViewBuilder private var usesSection: some View {
        Section(tr("Model uses")) {
            Text(tr("Pick the provider and model for each use. Only providers that can do a use are offered.")).font(.caption)
            ForEach(AiProviders.uses(catalog).indices, id: \.self) { i in
                let use = AiProviders.uses(catalog)[i]
                let id = use["id"].text
                let value = current(use)
                let chosen = providers.first { $0["id"].text == value["provider"].text }
                VStack(alignment: .leading, spacing: 6) {
                    Picker(tr(use["label"].text), selection: Binding(get: { current(use)["provider"].text }, set: { uses[id] = AiProviders.choose(current(use), $0) })) {
                        ForEach(AiProviders.modes(use), id: \.self) { Text(tr(AiProviders.modeLabel(use, $0))).tag($0) }
                        ForEach(AiProviders.fitting(catalog, providers: providers, use: use).map { $0["id"].text }, id: \.self) { pid in
                            let p = providers.first { $0["id"].text == pid }
                            Text((p?["name"].text ?? "") + " · " + kindLabel(p?["kind"].text ?? "")).tag(pid)
                        }
                    }
                    if let chosen {
                        TextField(tr("Model"), text: Binding(get: { current(use)["model"].text }, set: { v in update(id) { $0["model"] = .string(v) } }))
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        let suggested = AiProviders.suggestions(catalog, kind: chosen["kind"].text, capability: use["capability"].text)
                        if !suggested.isEmpty {
                            Menu(tr("Model") + "…") { ForEach(suggested, id: \.self) { m in Button(m) { update(id) { $0["model"] = .string(m) } } } }.font(.caption)
                        }
                        ForEach(AiProviders.optionKeys(capability: use["capability"].text, providerKind: chosen["kind"].text), id: \.self) { key in
                            let binding = Binding<String>(get: { current(use)["options"][key].string ?? (key == "reasoning_effort" || key == "voice" ? "" : "auto") },
                                                          set: { v in update(id) { var o = $0["options"]?.object ?? [:]; o[key] = .string(v); $0["options"] = .object(o) } })
                            if let choices = AiProviders.optionChoices(key) {
                                Picker(optionTitle(key), selection: binding) {
                                    ForEach(choices, id: \.self) { c in Text(optionLabel(key, c)).tag(c) }
                                }
                            } else { TextField(tr("Default voice"), text: binding).textInputAutocapitalization(.never).autocorrectionDisabled() }
                        }
                    }
                }
            }
            let changed = uses != ai["uses"].object
            if changed { Button(tr("Undo changes")) { uses = ai["uses"].object } }
            Button(tr("Save model uses")) { Task { await model.run {
                ai = try await model.get(["servers", model.serverId, "ai", "uses"], body: AiProviders.usesBody(saved: ai["uses"], edited: uses), method: "PUT")
                uses = ai["uses"].object; try await model.refreshCatalog(); model.notice = tr("Model uses saved")
            } } }.disabled(model.busy || !changed)
            Text(tr("Keys are encrypted on the server and never sent back to the browser.")).font(.caption)
        }
    }
}

struct StoryControls: View {
    @ObservedObject var model: AppModel
    @State private var reveal = false
    @State private var confirm = false
    var body: some View {
        Section(tr("Story")) {
            Text(tr(model.channel["story_status"].text == "ended" ? "ended" : "ongoing"))
            if model.channel["story_status"].text == "ended" {
                Text(tr(model.channel["story_reveal_all"].bool ? "Every member can read the whole story in the Log Studio, GM-only lines included." : "Every member can read the whole story in the Log Studio. GM-only lines stay with you."))
                Button(tr("Reopen the story")) { Task { await model.run { _ = try await model.get(["channels", model.channelId, "story", "reopen"], body: .object([:])); try await model.refresh() } } }
            } else {
                Text(tr("When the story ends, the Log Studio opens to every member and the campaign log shows them the whole story: every chat window, whispers and hidden rolls, and the scenario titles.")).font(.caption)
                Toggle(tr("Also reveal GM-only lines"), isOn: $reveal)
                Button(tr("End the story")) { confirm = true }
            }
        }.disabled(model.busy).confirmationDialog(tr("End the story? Every member of this channel will be able to read the whole story in the Log Studio."), isPresented: $confirm, titleVisibility: .visible) {
            Button(tr("End the story")) { Task { await model.run { _ = try await model.get(["channels", model.channelId, "story", "end"], body: .object(["reveal_keeper_lines": .bool(reveal)])); try await model.refresh() } } }
        }
    }
}
