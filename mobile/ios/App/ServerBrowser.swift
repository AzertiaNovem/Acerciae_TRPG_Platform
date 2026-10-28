import SwiftUI
import AcerciaeCore

struct ServerBrowser: View {
    @ObservedObject var model: AppModel
    @State private var query = ""
    @State private var code = ""
    @State private var invite: JSONValue = .null
    @State private var servers: [Resource] = []
    @State private var watching: [Resource] = []
    @State private var error = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            if !error.isEmpty { Text(error).foregroundStyle(.orange) }
            Section(tr("Join a server")) {
                TextField(tr("Invite code"), text: $code).textInputAutocapitalization(.never).autocorrectionDisabled().onChange(of: code) { _, _ in invite = .null }
                Button(tr("Preview")) { Task { await model.run { invite = try await model.get(["invites", code.trimmingCharacters(in: .whitespacesAndNewlines)]) } } }.disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
                if invite != .null {
                    Text(invite["name"].text)
                    Button(tr("Join")) { Task { await model.run { let joined = try await model.get(["invites", code.trimmingCharacters(in: .whitespacesAndNewlines), "accept"], body: .object([:])); try await joinedServer(joined["id"].text) } } }.disabled(!invite["valid"].bool || model.busy)
                }
            }
            Section(tr("Open servers")) {
                TextField(tr("Search"), text: $query)
                Button(tr("Search")) { Task { await load() } }.disabled(model.busy)
                ForEach(servers) { server in
                    HStack {
                        VStack(alignment: .leading) { Text(server.name); Text("\(server["member_count"].int) " + tr("Members")).font(.caption) }
                        Spacer()
                        Button(tr(model.servers.contains { $0.id == server.id } ? "Open" : "Join")) { Task { await model.run {
                            if !model.servers.contains(where: { $0.id == server.id }) { _ = try await model.get(["servers", server.id, "join"], body: .object([:])) }
                            try await joinedServer(server.id)
                        } } }.disabled(model.busy)
                    }
                }
            }
            if !watching.isEmpty { Section(tr("Read-only Main Chat")) { ForEach(watching) { item in NavigationLink(item.name) { SpectatorView(model: model, channel: item) } } } }
        }.navigationTitle(tr("Servers")).toolbar { Button(tr("Done")) { dismiss() } }.task { await load() }
    }
    private func joinedServer(_ id: String) async throws { try await model.refreshCatalog(); try await model.selectServer(id); dismiss() }
    private func load() async {
        await model.run {
            servers = try await model.typed(["server-directory"], query: ["q": query])
            watching = []
            if !model.serverId.isEmpty && model.serverRole != "guest" && model.serverSettings["policy"]["main_chat_spectators"].bool { watching = try await model.typed(["servers", model.serverId, "spectate"]) }
        }
    }
}
private struct SpectatorView: View {
    @ObservedObject var model: AppModel
    let channel: Resource
    @State private var messages: [JSONValue] = []
    @State private var loading = false
    @State private var failed = ""
    @State private var more = false
    var body: some View {
        List {
            Text(tr("Read-only Main Chat")).font(.caption)
            if !failed.isEmpty { Text(failed).foregroundStyle(.orange) }
            if more { Button(tr("Load earlier messages")) { Task { await load(older: true) } }.disabled(loading) }
            // The spectator endpoint already strips private fields. Never enrich with channel characters or documents.
            ForEach(Array(messages.enumerated()), id: \.offset) { _, item in VStack(alignment: .leading, spacing: 6) { Text(item["author_name"].text).font(.caption).foregroundStyle(.secondary); Text(item["content"].text).textSelection(.enabled) } }
        }.navigationTitle(channel.name).task { await load() }.refreshable { await load() }
    }
    private func load(older: Bool = false) async {
        guard !loading else { return }; loading = true; defer { loading = false }
        do {
            var query = ["limit": "50"]; if older { query["before_seq"] = String(messages.first?["seq"].int ?? 0) }
            let result = try await model.get(["channels", channel.id, "spectate"], query: query)
            let next = result["messages"].array; messages = older ? next + messages : next; more = next.count >= 50; failed = ""
        } catch { messages = []; more = false; failed = tr("Something went wrong in this view.") }
    }
}
