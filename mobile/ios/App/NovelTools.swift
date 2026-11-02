import SwiftUI
import AcerciaeCore
struct NovelTools: View {
    @ObservedObject var model: AppModel
    let presentation: String
    let canContinue: Bool
    @Binding var exported: URL?
    @State private var bundles: [Resource] = []
    @State private var status: JSONValue = .null
    @State private var cloud = false
    @State private var art = false
    @State private var continuation = false
    @Environment(\.scenePhase) private var phase
    private var base: [String] { ["channels",model.channelId,"studio"] }
    var body: some View {
        VStack(alignment:.leading,spacing:8) {
            Button(tr("Prepare download")) { Task { await model.run {
                _ = try await model.get(base+["presentations",presentation,"bundle"],body:.object([:])); try await reload()
            } } }.disabled(model.busy)
            ForEach(bundles) { job in
                Text(tr(job["status"].text) + " · \(job["progress"]["files_done"].int)/\(job["progress"]["files_total"].int)").font(.caption)
                if !job["error"].text.isEmpty { Text(job["error"].text).font(.caption).foregroundStyle(.orange) }
                if job["status"].text == "ready" {
                    Button(tr("Download") + " ZIP") { Task { await model.run {
                        let data = try await model.bytes(base+["bundles",job.id,"download"])
                        let url = FileManager.default.temporaryDirectory.appendingPathComponent("novel-\(UUID()).zip"); try data.write(to:url,options:.atomic); exported=url
                    } } }.disabled(model.busy)
                }
            }
            if canContinue { DisclosureGroup(tr("Continue the story")) {
                Text(tr("The lines posted since this visual novel ends are written as new scenes after it, in the same point of view. The AI is told where the story stopped and reuses its backgrounds and portraits; it asks only for the places and poses that are new. The direction above applies.")).font(.caption)
                if !status["mock"].bool { Toggle(tr("同意将选定日志发送至配置的云端服务"),isOn:$cloud).disabled(!status["cloud_allowed"].bool) }
                Toggle(tr("同时生成缺失的背景与立绘"),isOn:$art).disabled(!status["images"].bool)
                Button(tr("Continue the story")) { Task { await model.run {
                    _ = try await model.get(base+["vn-scripts"],body:.object(["continue_presentation_id":.string(presentation),"allow_cloud":.bool(cloud),"generate_art":.bool(art)])); continuation=true
                } } }.disabled(model.busy || status == .null || (!status["mock"].bool && (!cloud || !status["cloud_allowed"].bool)))
                if continuation { Text(tr("Continuation queued. Follow progress in visual novel tasks.")).font(.caption) }
            }
            }
        }.task(id:phase) { guard phase == .active else { return }; do {
            status=try await model.get(base+["vn-scripts","status"])
            while !Task.isCancelled { try await reload(); try await Task.sleep(for:.seconds(4)) }
        } catch { if !Task.isCancelled { model.handle(error) } } }
    }
    private func reload() async throws { bundles=try await model.typed(base+["presentations",presentation,"bundles"]) }
}
struct NovelRecovery: View {
    @ObservedObject var model: AppModel
    let jobId: String
    @State private var job: JSONValue = .null
    @State private var retryChunks = true
    @Environment(\.scenePhase) private var phase
    private var base: [String] { ["channels",model.channelId,"studio","vn-scripts",jobId] }
    var body: some View {
        VStack(alignment:.leading,spacing:8) {
            if job["status"].text == "failed" {
                Toggle(tr("Retry failed chunks"),isOn:$retryChunks)
                Button(tr("Retry script")) { Task { await model.run { job=try await model.get(base+["retry"],body:.object(["retry_failed_chunks":.bool(retryChunks)])) } } }.disabled(model.busy)
            }
            ForEach(Array(job["background_jobs"].array.enumerated()),id:\.offset) { _, bg in
                Text(bg["scene_key"].text + " · " + tr(bg["status"].text)).font(.caption)
                if !bg["error"].text.isEmpty { Text(bg["error"].text).font(.caption).foregroundStyle(.orange) }
                if ["missing","failed","cancelled"].contains(bg["status"].text) {
                    Button(tr("Retry background")) { Task { await model.run {
                        _ = try await model.get(base+["backgrounds","retry"],body:.object(["scene_key":.string(bg["scene_key"].text)])); job=try await model.get(base)
                    } } }.disabled(model.busy)
                }
            }
        }.task(id:phase) { guard phase == .active else { return }; do { while !Task.isCancelled { job=try await model.get(base); try await Task.sleep(for:.seconds(4)) } } catch { if !Task.isCancelled { model.handle(error) } } }
    }
}
