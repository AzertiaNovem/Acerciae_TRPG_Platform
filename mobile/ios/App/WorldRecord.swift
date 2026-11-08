import SwiftUI
import AcerciaeCore
struct WorldRecord: View {
    @ObservedObject var model: AppModel
    @State private var world: JSONValue = .null
    @State private var declaration = ""
    @State private var secret = true
    @State private var error = ""
    @Environment(\.scenePhase) private var phase
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(tr("World record")).font(.headline)
            if !error.isEmpty { Text(error).foregroundStyle(.orange) }
            entities
            recentChanges
            if model.gm { declarationForm }
            Button(tr("Refresh")) { Task { do { try await reload() } catch { self.error = error.localizedDescription } } }
        }.task(id: phase) { guard phase == .active else { return }; do { while !Task.isCancelled { try await reload(); try await Task.sleep(for:.seconds(5)) } } catch { if !Task.isCancelled { self.error = error.localizedDescription } } }
    }

    @ViewBuilder private var entities: some View {
        ForEach(Array(world["entities"].array.enumerated()), id: \.offset) { _, entity in
            entityRow(entity)
        }
        if world["entities"].array.isEmpty { Text(tr("No world state recorded yet.")) }
    }

    private func entityRow(_ entity: JSONValue) -> some View {
        let title = "\(entity["name"].text) · \(tr(entity["status"].text))"
        let location = entity["location"]["name"].text
        return DisclosureGroup(title) {
            Text(entity["description"].text)
            Text(entity["state"].string ?? entity["state"].pretty).textSelection(.enabled)
            if !location.isEmpty { Text("\(tr("Location")) · \(location)") }
            Text("v\(entity["state_version"].int) · \(entity["state_updated_at"].text)").font(.caption)
        }
    }

    private var recentChanges: some View {
        DisclosureGroup(tr("Recent changes")) {
            ForEach(Array(world["recent_changes"].array.enumerated()), id: \.offset) { _, change in
                let state = change["state"].string ?? change["state"].pretty
                let text = "\(change["name"].text) · \(tr(change["status"].text))\n\(state)"
                Text(text).font(.caption)
            }
        }
    }

    @ViewBuilder private var declarationForm: some View {
        TextField(tr("Declare a change in the world"), text: $declaration, axis: .vertical)
        Toggle(tr("Secret"), isOn: $secret)
        Button(tr("Record declaration")) { Task { await model.run { try await recordDeclaration() } } }
            .disabled(model.busy || declaration.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || declaration.count > 4000)
    }

    private func recordDeclaration() async throws {
        let body: JSONValue = .object(["text": .string(declaration), "secret": .bool(secret)])
        let query = ["observe": model.channel["ai_enabled"].bool ? "true" : "false"]
        _ = try await model.get(["channels", model.channelId, "world", "declare"], body: body, query: query)
        declaration = ""
        try await reload()
    }

    private func reload() async throws { world = try await model.get(["channels",model.channelId,"world"]); error = "" }
}
