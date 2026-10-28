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
                    provider("llm", title: "Language model", providers: ["mock", "openai_compatible", "anthropic"], fields: ["api_base", "model", "embedding_model", "reasoning_effort"])
                    provider("image", title: "Image generation", providers: ["disabled", "mock", "gpt_image"], fields: ["api_base", "model", "size", "quality"])
                    provider("tts", title: "Voice", providers: ["disabled", "mock", "qwen"], fields: ["api_base", "model", "voice"])
                    Section(tr("AI policy")) {
                        ForEach(["token_budget", "image_budget", "max_concurrent"], id: \.self) { key in LabeledContent(tr(fieldName(key))) { TextField(tr(fieldName(key)), text: number("ai_policy", key)).keyboardType(.numberPad).multilineTextAlignment(.trailing) } }
                        choice("ai_policy", "period", "Budget period", [("month", "Each calendar month"), ("total", "Total")])
                        Text("\(tr("Tokens used")): \(model.serverSettings["ai_policy"]["tokens_used"].int) · \(tr("Images used")): \(model.serverSettings["ai_policy"]["images_used"].int)").font(.caption)
                    }
                    save(["llm", "image", "tts", "ai_policy"])
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
    private func provider(_ key: String, title: String, providers: [String], fields: [String]) -> some View {
        Section(tr(title)) {
            choice(key, "provider", "Provider", providers.map { ($0, $0) })
            ForEach(fields, id: \.self) { field in VStack(alignment: .leading) { Text(tr(fieldName(field))).font(.caption).foregroundStyle(.secondary); TextField(tr(fieldName(field)), text: value(key, field)).textInputAutocapitalization(.never).autocorrectionDisabled() } }
            SecureField(tr("New API key (leave blank to keep)"), text: value(key, "api_key"))
            Text(model.serverSettings[key]["api_key_hint"].text).font(.caption)
            Toggle(tr("Clear saved API key"), isOn: flag(key, "clear_api_key"))
        }
    }
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
func fieldName(_ key: String) -> String { ["api_base":"API base URL", "model":"Model", "embedding_model":"Embedding model", "reasoning_effort":"Thinking effort", "size":"Image size", "quality":"Image quality", "voice":"Voice", "token_budget":"Token budget", "image_budget":"Image budget", "max_concurrent":"Simultaneous AI tasks"][key] ?? key }

struct StoryControls: View {
    @ObservedObject var model: AppModel
    @State private var reveal = false
    @State private var confirm = false
    var body: some View {
        Section(tr("Story")) {
            Text(tr(model.channel["story_status"].text == "ended" ? "ended" : "ongoing"))
            if model.channel["story_status"].text == "ended" {
                Text(tr(model.channel["story_reveal_all"].bool ? "Every member can read the whole story in the Log Studio, Keeper-only lines included." : "Every member can read the whole story in the Log Studio. Keeper-only lines stay with you."))
                Button(tr("Reopen the story")) { Task { await model.run { _ = try await model.get(["channels", model.channelId, "story", "reopen"], body: .object([:])); try await model.refresh() } } }
            } else {
                Text(tr("When the story ends, the Log Studio opens to every member and the campaign log shows them the whole story: every chat window, whispers and hidden rolls, and the scenario titles.")).font(.caption)
                Toggle(tr("Also reveal Keeper-only lines"), isOn: $reveal)
                Button(tr("End the story")) { confirm = true }
            }
        }.disabled(model.busy).confirmationDialog(tr("End the story? Every member of this channel will be able to read the whole story in the Log Studio."), isPresented: $confirm, titleVisibility: .visible) {
            Button(tr("End the story")) { Task { await model.run { _ = try await model.get(["channels", model.channelId, "story", "end"], body: .object(["reveal_keeper_lines": .bool(reveal)])); try await model.refresh() } } }
        }
    }
}
