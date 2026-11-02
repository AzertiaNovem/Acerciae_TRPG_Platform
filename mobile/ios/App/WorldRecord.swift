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
            ForEach(Array(world["entities"].array.enumerated()), id: \.offset) { _, entity in
                DisclosureGroup(entity["name"].text + " · " + tr(entity["status"].text)) {
                    Text(entity["description"].text)
                    Text(entity["state"].string ?? entity["state"].pretty).textSelection(.enabled)
                    if !entity["location"]["name"].text.isEmpty { Text(tr("Location") + " · " + entity["location"]["name"].text) }
                    Text("v\(entity["state_version"].int) · \(entity["state_updated_at"].text)").font(.caption)
                }
            }
            if world["entities"].array.isEmpty { Text(tr("No world state recorded yet.")) }
            DisclosureGroup(tr("Recent changes")) {
                ForEach(Array(world["recent_changes"].array.enumerated()), id: \.offset) { _, change in
                    Text(change["name"].text + " · " + tr(change["status"].text) + "\n" + (change["state"].string ?? change["state"].pretty)).font(.caption)
                }
            }
            if model.gm {
                TextField(tr("Declare a change in the world"), text: $declaration, axis: .vertical)
                Toggle(tr("Secret"), isOn: $secret)
                Button(tr("Record declaration")) { Task { await model.run {
                    _ = try await model.get(["channels",model.channelId,"world","declare"], body: .object(["text":.string(declaration),"secret":.bool(secret)]), query: ["observe": model.channel["ai_enabled"].bool ? "true" : "false"])
                    declaration = ""; try await reload()
                } } }.disabled(model.busy || declaration.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || declaration.count > 4000)
            }
            Button(tr("Refresh")) { Task { do { try await reload() } catch { self.error = error.localizedDescription } } }
        }.task(id: phase) { guard phase == .active else { return }; do { while !Task.isCancelled { try await reload(); try await Task.sleep(for:.seconds(5)) } } catch { if !Task.isCancelled { self.error = error.localizedDescription } } }
    }
    private func reload() async throws { world = try await model.get(["channels",model.channelId,"world"]); error = "" }
}
