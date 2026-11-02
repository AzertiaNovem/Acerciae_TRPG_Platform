import SwiftUI
import UniformTypeIdentifiers
import AcerciaeCore

struct ModuleImports: View {
    @ObservedObject var model: AppModel
    @State private var modules: [Resource] = []
    @State private var builds: [Resource] = []
    @State private var title = ""
    @State private var text = ""
    @State private var importing = false
    @FocusState private var field: String?
    @Environment(\.scenePhase) private var phase
    private var base: [String] { ["channels", model.channelId] }
    var body: some View {
        Form {
            if model.gm {
                Section(tr("Import module")) {
                    TextField(tr("Title"), text: $title).focused($field, equals: "title")
                    TextField(tr("Module text"), text: $text, axis: .vertical).lineLimit(4...12).focused($field, equals: "text")
                    Button(tr("Import text")) { field = nil; Task { await model.run {
                        let result = try await model.get(base + ["modules", "text"], body: .object(["title": .string(title), "text": .string(text), "async": .bool(true)]))
                        if result["deduplicated"].bool { model.notice = tr("This module already exists. Showing its current task.") }
                        try await refresh(); text = ""
                    } } }.disabled(model.busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button(tr("Import PDF")) { field = nil; importing = true }.disabled(model.busy)
                    Text(tr("Imports continue on the server when you leave this page. Ready with a warning means the module graph is usable.")).font(.caption)
                }
                ForEach(modules) { module in
                    Section(module.name) {
                        Text(stageLabel(module["import_stage"].string ?? module["status"].text))
                        if module["import_stage"].text == "structuring", module["total_chunks"].int > 0 {
                            ProgressView(value: Double(module["completed_chunks"].int), total: Double(module["total_chunks"].int))
                            Text("\(module["completed_chunks"].int) / \(module["total_chunks"].int) " + tr("chunks"))
                        } else if !["ready", "failed"].contains(module["status"].text) { ProgressView() }
                        if !module["error"].text.isEmpty { Text(module["error"].text).foregroundStyle(.red) }
                        if !module["import_warning"].text.isEmpty { Text(module["import_warning"].text).foregroundStyle(.orange) }
                        if module["status"].text == "failed" {
                            Button(tr("Retry import")) { Task { await model.run { _ = try await model.get(base + ["modules", module.id, "retry"], body: .object([:])); try await refresh() } } }.disabled(model.busy)
                        }
                        if module["status"].text == "ready" {
                            Button(tr("Rebuild script knowledge")) { Task { await model.run {
                                _ = try await model.get(base + ["script-knowledge", "rebuild"], body: .object(["module_id": .string(module.id), "async": .bool(true)])); try await refresh()
                            } } }.disabled(model.busy || builds.contains { $0["module_id"].text == module.id && ["pending", "running"].contains($0["status"].text) })
                        }
                    }
                }
                ForEach(builds) { build in
                    Section(tr("Script knowledge") + " · " + (modules.first { $0.id == build["module_id"].text }?.name ?? "")) {
                        Text(stageLabel(build["status"].text))
                        if build["total_batches"].int > 0 { Text("\(build["completed_batches"].int) / \(build["total_batches"].int) " + tr("batches")) }
                        if ["pending", "running"].contains(build["status"].text) { ProgressView() }
                        if !build["error"].text.isEmpty { Text(build["error"].text).foregroundStyle(.red) }
                        if build["status"].text == "completed" { Text(tr("Entries") + " · \(build["result"]["entries"].int)") }
                    }
                }
                Button(tr("Refresh")) { Task { await model.run { try await refresh() } } }.disabled(model.busy)
            }
        }.scrollDismissesKeyboard(.interactively).navigationTitle(tr("Module imports"))
        .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf]) { result in Task { await model.run {
            let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
            guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 25 * 1024 * 1024 else { model.notice = tr("Choose a PDF smaller than 25 MB"); return }
            let value = try await model.uploadModule(Data(contentsOf: url), title: title.isEmpty ? url.deletingPathExtension().lastPathComponent : title)
            if value["deduplicated"].bool { model.notice = tr("This module already exists. Showing its current task.") }
            try await refresh()
        } } }
        .task(id: phase) {
            guard phase == .active, model.gm else { return }
            do { while !Task.isCancelled {
                if !model.busy { try await refresh() }
                try await Task.sleep(for: .seconds(5))
            } } catch is CancellationError {} catch { if !Task.isCancelled { model.handle(error) } }
        }
    }
    private func refresh() async throws {
        modules = try await model.typed(base + ["modules"])
        builds = try await model.typed(base + ["script-knowledge", "builds"])
    }
}

private func stageLabel(_ value: String) -> String {
    tr(["queued": "Queued", "uploaded": "Queued", "extracting": "Extracting PDF text", "structuring": "Structuring module", "knowledge": "Building script knowledge", "ready": "Ready", "failed": "Failed", "pending": "Pending", "running": "Running", "completed": "Completed"][value] ?? value)
}
