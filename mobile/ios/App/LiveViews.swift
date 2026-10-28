import SwiftUI
import AVFoundation
import AcerciaeCore

struct CharacterView: View {
    @ObservedObject var model: AppModel
    let character: Resource
    @State private var space: JSONValue = .null
    @State private var attributes: JSONValue = .null
    @State private var loading = true
    @State private var attribute = ""
    @State private var value = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        Form {
            Section {
                if !space["portrait"]["id"].text.isEmpty {
                    artwork(space["portrait"], height: 360).accessibilityLabel(tr("主立绘"))
                } else if loading { ProgressView() }
                else { ContentUnavailableView(tr("尚无立绘"), systemImage: "person.crop.rectangle") }
                HStack(spacing: 14) {
                    if !space["avatar"]["id"].text.isEmpty { artwork(space["avatar"], height: 72).frame(width: 72).accessibilityLabel(tr("头像")) }
                    VStack(alignment: .leading, spacing: 6) {
                        Text(space["character"]["name"].string ?? character.name).font(.title2.bold())
                        Text(character["kind"].text.uppercased() + " · " + character["player_name"].text).font(.caption).foregroundStyle(.secondary)
                        if !space["era"].text.isEmpty { Text(space["era"].text).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                if !space["character"]["bio"].text.isEmpty { Text(space["character"]["bio"].text).textSelection(.enabled) }
                if !space["character"]["speaking_style"].text.isEmpty { LabeledContent(tr("说话风格"), value: space["character"]["speaking_style"].text) }
                NavigationLink(tr("角色卡与外观空间")) { CharacterSpace(model: model, character: character) }
            }
            if !space["subtitles"].array.isEmpty {
                Section(tr("表情立绘")) {
                    ForEach(Array(space["subtitles"].array.enumerated()), id: \.offset) { _, asset in
                        VStack(alignment: .leading) { Text(asset["subtitle"].text).font(.headline); artwork(asset, height: 260).accessibilityLabel(asset["subtitle"].text) }
                    }
                }
            }
            Section(tr("属性")) {
                ForEach(attributes["attrs"].object.keys.sorted(), id: \.self) { key in
                    LabeledContent(key, value: String(attributes["attrs"][key].int))
                }
                if attributes["editable"].bool && !model.enabled("coc7_points") {
                    TextField(tr("属性或技能名"), text: $attribute)
                    TextField(tr("数值"), text: $value).keyboardType(.numbersAndPunctuation)
                    Button(tr("保存属性")) { Task { await model.run {
                        guard let number = Double(value) else { return }
                        _ = try await model.get(["channels", model.channelId, "characters", character.id, "attributes"], body: .object(["set": .object([attribute: .number(number)])]), method: "PUT")
                        try await load()
                    } } }.disabled(attribute.isEmpty || Double(value) == nil || model.busy)
                }
            }
        }.navigationTitle(tr("角色主页")).navigationBarTitleDisplayMode(.inline)
            .toolbar { Button(tr("完成")) { dismiss() } }
            .task { do { try await load() } catch { model.handle(error) }; loading = false }
    }
    private func load() async throws {
        space = try await model.get(["channels", model.channelId, "characters", character.id, "space"])
        attributes = try await model.get(["channels", model.channelId, "characters", character.id, "attributes"])
    }
    private func artwork(_ asset: JSONValue, height: CGFloat) -> some View {
        NavigationLink {
            ScrollView { AuthenticatedArtwork(model: model, assetId: asset["id"].text, version: asset["version"].int).frame(minHeight: 480).padding() }
                .navigationTitle(asset["subtitle"].string ?? character.name)
        } label: {
            AuthenticatedArtwork(model: model, assetId: asset["id"].text, version: asset["version"].int).frame(maxWidth: .infinity).frame(height: height)
        }.buttonStyle(.plain)
    }
}

struct SceneView: View {
    @ObservedObject var model: AppModel
    let scene: Resource
    @State private var summary = ""
    @State private var confirm = false
    @Environment(\.dismiss) private var dismiss
    private var current: Resource { model.scenes.first { $0.id == scene.id } ?? scene }
    var body: some View {
        Form {
            Text(current.name)
            LabeledContent(tr("地点"), value: current["location"].text)
            LabeledContent(tr("时间"), value: current["narrative_time"].text)
            Text(model.channel["current_scene_id"].text == scene.id ? tr("当前阶段 · 全战役") : current["status"].text == "closed" ? tr("已结束 · 仅供回顾") : tr("已准备，尚未进入"))
            if model.gm {
                TextField(tr("阶段摘要"), text: $summary, axis: .vertical)
                Button(tr("保存摘要")) { Task { await model.run {
                    _ = try await model.get(["channels", model.channelId, "scenes", scene.id], body: .object(["summary": .string(summary)]), method: "PUT"); try await model.refresh()
                } } }.disabled(model.busy)
                if current["status"].text == "active" && model.channel["current_scene_id"].text != scene.id {
                    Button(tr("全战役进入此阶段")) { confirm = true }.disabled(model.busy)
                }
            } else { Text(current["summary"].text.isEmpty ? tr("暂无阶段摘要") : current["summary"].text) }
        }.navigationTitle(tr("阶段详情")).navigationBarTitleDisplayMode(.inline)
            .onAppear { summary = current["summary"].text }
            .toolbar { Button(tr("完成")) { dismiss() } }
            .confirmationDialog(tr("进入后，所有聊天窗口一起切换，当前阶段将关闭"), isPresented: $confirm, titleVisibility: .visible) {
                Button(tr("进入此阶段")) { Task { await model.run {
                    _ = try await model.get(["channels", model.channelId, "scenarios", "enter"], body: .object(["scene_id": .string(scene.id)])); try await model.refresh(); dismiss()
                } } }
            } message: { Text(scene.name + "\n" + scene["location"].text + " · " + scene["narrative_time"].text + "\n" + tr("This cannot be undone.")) }
    }
}

struct LiveServerView: View {
    @ObservedObject var model: AppModel
    @State private var points = false
    @State private var studio = false
    @State private var dice = false
    @State private var consistency = false
    @State private var inspiration = false
    @State private var language = "zh"
    var body: some View {
        Group {
            if model.online && model.serverSettings["is_maintainer"].bool {
                Form {
            Section {
                ForEach(["Access", "AI", "Channels"], id: \.self) { area in NavigationLink(tr(area)) { ServerManagementView(model: model, area: area) } }
            }
            Section(model.serverName) {
                Text(model.serverSettings["is_maintainer"].bool ? tr("服务器管理员") : tr("服务器成员"))
                if model.serverSettings["features"]["coc7_points"] != .null { Toggle(tr("CoC7 购点规则"), isOn: $points) }
                Toggle(tr("日志制作"), isOn: $studio)
                Toggle(tr("骰子"), isOn: $dice)
                Toggle(tr("一致性检查"), isOn: $consistency)
                Toggle(tr("灵感草稿"), isOn: $inspiration)
                Picker(tr("Language"), selection: $language) { ForEach(Array(zip(InterfaceLanguage.codes, InterfaceLanguage.names)), id: \.0) { code, name in Text(name).tag(code) } }
                if model.serverSettings["is_maintainer"].bool {
                    Button(tr("保存服务器设置")) { Task { await model.run {
                        var features = model.serverSettings["features"].object
                        features["log_studio"] = .bool(studio); features["dice"] = .bool(dice); features["consistency"] = .bool(consistency); features["inspiration"] = .bool(inspiration)
                        if features["coc7_points"] != nil { features["coc7_points"] = .bool(points) }
                        model.serverSettings = try await model.get(["servers", model.serverId, "settings"], body: .object(["language": .string(language), "features": .object(features)]), method: "PUT")
                    } } }
                }
            }.disabled(!model.serverSettings["is_maintainer"].bool || model.busy)

                }
            } else { ContentUnavailableView(tr("仅服务器管理员可访问"), systemImage: "lock") }
        }.navigationTitle(tr("服务器选项")).navigationBarTitleDisplayMode(.inline)
            .task(id: model.serverId) {
                points = model.enabled("coc7_points"); studio = model.enabled("log_studio")
                dice = model.enabled("dice"); consistency = model.enabled("consistency"); inspiration = model.enabled("inspiration")
                language = InterfaceLanguage.supported(model.serverSettings["language"].text)
            }
    }
}

struct LiveChannelView: View {
    @ObservedObject var model: AppModel
    @State private var visible = false
    @State private var playerAccess = false
    @State private var autoScenarios = false
    @State private var ai = false
    @State private var cloud = false
    @State private var budget = "0"
    @State private var studioLoaded = false
    @State private var channelName = ""
    @State private var channelDescription = ""
    @State private var era = ""
    @State private var knowledgeMode = "isolated"
    @State private var diceGroup = ""
    @State private var diceGroups: [Resource] = []
    @State private var inviteUsername = ""
    var body: some View {
        Group {
            if model.online && model.gm {
                Form {
                    Section { Text(model.channel["name"].text).font(.headline); Text(tr("以下设置仅作用于当前频道")).font(.caption) }
                Section(tr("守密人设置")) {
                    TextField(tr("频道名称"), text: $channelName)
                    TextField(tr("频道介绍"), text: $channelDescription, axis: .vertical)
                    TextField(tr("故事年代"), text: $era)
                    Picker(tr("角色知识"), selection: $knowledgeMode) {
                        Text(tr("隔离：各自掌握线索")).tag("isolated"); Text(tr("公开：共享知识")).tag("public")
                    }
                    Text(tr("公开模式会让角色共享频道知识；隔离模式按角色可见范围提供线索。")).font(.caption)
                    Picker(tr("骰子回复"), selection: $diceGroup) {
                        Text(tr("跟随服务器")).tag(""); Text("中文").tag("builtin:zh"); Text("English").tag("builtin:en")
                        ForEach(diceGroups) { group in Text(group.name).tag(group.id) }
                        if !diceGroup.isEmpty && !diceGroup.hasPrefix("builtin:") && !diceGroups.contains(where: { $0.id == diceGroup }) { Text(tr("当前自定义回复")).tag(diceGroup) }
                    }
                    Toggle(tr("AI 观察与整理"), isOn: $ai)
                    Toggle(tr("向成员显示日志制作"), isOn: $visible)
                    Toggle(tr("Players may open the Log Studio before the story ends"), isOn: $playerAccess)
                    Toggle(tr("根据叙述建议新阶段"), isOn: $autoScenarios)
                    Button(tr("保存频道设置")) { Task { await model.run {
                        model.channel = try await model.get(["channels", model.channelId], body: .object(["name": .string(channelName.trimmingCharacters(in: .whitespacesAndNewlines)), "description": .string(channelDescription), "era": .string(era), "knowledge_mode": .string(knowledgeMode), "dice_text_group": .string(diceGroup), "ai_enabled": .bool(ai), "studio_visible": .bool(visible), "studio_player_access": .bool(playerAccess), "auto_scenarios": .bool(autoScenarios)]), method: "PUT")
                        try await model.refreshCatalog(); try await model.refresh(); model.notice = tr("守密人设置已保存")
                    } } }.disabled(channelName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || era.count > 80)
                    if studioLoaded {
                        Toggle(tr("允许日志制作使用云端处理"), isOn: $cloud)
                        TextField(tr("配音字符预算"), text: $budget).keyboardType(.numberPad)
                        Button(tr("保存日志制作设置")) { Task { await model.run {
                            _ = try await model.get(["channels", model.channelId, "studio", "settings"], body: .object(["studio_cloud_allowed": .bool(cloud), "tts_budget_chars": .number(Double(budget) ?? 0)]), method: "PUT")
                        } } }.disabled(Int(budget) == nil || (Int(budget) ?? -1) < 0)
                    }
                }.disabled(model.busy)
                Section(tr("邀请玩家")) {
                    TextField(tr("玩家的账号名"), text: $inviteUsername).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text(tr(model.serverSettings["is_maintainer"].bool || model.serverSettings["policy"]["guest_invites"].bool ? "You may invite registered users outside this server as channel guests." : "You may invite existing server members to this channel.")).font(.caption)
                    Button(tr("添加到频道")) { Task { await model.run {
                        _ = try await model.get(["channels", model.channelId, "members"], body: .object(["username": .string(inviteUsername.trimmingCharacters(in: .whitespacesAndNewlines)), "role": .string("player")]))
                        inviteUsername = ""; model.notice = tr("玩家已加入频道")
                    } } }.disabled(model.busy || inviteUsername.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                ScenarioControls(model: model)
                StoryControls(model: model)

                }
            } else { ContentUnavailableView(tr("仅当前频道的 GM 可访问"), systemImage: "lock") }
        }.navigationTitle(tr("频道选项")).navigationBarTitleDisplayMode(.inline)
            .task(id: model.channelId) {
                guard model.online && model.gm else { return }
                playerAccess = model.channel["studio_player_access"].bool
                visible = model.channel["studio_visible"].bool; autoScenarios = model.channel["auto_scenarios"].bool
                ai = model.channel["ai_enabled"].bool
                channelName = model.channel["name"].text; channelDescription = model.channel["description"].text
                era = model.channel["era"].text; knowledgeMode = model.channel["knowledge_mode"].text; diceGroup = model.channel["dice_text_group"].text
                diceGroups = []; studioLoaded = false
                diceGroups = (try? await model.typed(["servers", model.serverId, "dice-texts"])) ?? []
                guard model.studioAvailable else { return }
                await model.run {
                    let v = try await model.get(["channels", model.channelId, "studio", "settings"])
                    cloud = v["studio_cloud_allowed"].bool; budget = String(v["tts_budget_chars"].int); studioLoaded = true
                }
            }
    }
}

struct StudioView: View {
    @ObservedObject var model: AppModel
    @State private var log: JSONValue = .null
    @State private var presentations: [Resource] = []
    @State private var pdfJobs: [Resource] = []
    @State private var performanceScenes: [JSONValue] = []
    @State private var events: [JSONValue] = []
    @State private var presentationId = ""
    @State private var index = 0
    @State private var player: AVAudioPlayer?
    @State private var exported: URL?
    @State private var loading = false
    @State private var errorText = ""
    var body: some View {
        List {
            if !errorText.isEmpty { Text(errorText).foregroundStyle(.orange) }
            if loading { ProgressView() }
            if model.studioAvailable {
            if !events.isEmpty {
                let event = events[min(index, events.count - 1)]
                Section(tr("Play") + " · \(index + 1) / \(events.count)") {
                    let scene = performanceScenes.first { $0["id"].text == event["scene_id"].text }
                    if let asset = scene?["background_asset_id"].string {
                        AuthenticatedArtwork(model: model, assetId: asset, version: scene?["background_asset_version"].int ?? 0).frame(height: 180)
                    }
                    let standees = event["character_asset_ids"].array.filter { !$0["asset_id"].text.isEmpty }
                    if !standees.isEmpty { HStack { ForEach(Array(standees.enumerated()), id: \.offset) { _, item in
                        AuthenticatedArtwork(model: model, assetId: item["asset_id"].text, version: item["asset_version"].int).frame(maxWidth: .infinity).frame(height: 140)
                    } } }
                    Text(event["speaker_name_override"].string ?? event["speaker_display_name"].text).font(.headline)
                    Text(event["display_kind"].text == "dice" ? (event["dice"]["text"].string ?? event["display_text"].text) : event["display_text"].text).textSelection(.enabled)
                    HStack {
                        Button(tr("上一段")) { move(-1) }.disabled(index == 0)
                        Spacer()
                        Button(tr("下一段")) { move(1) }.disabled(index == events.count - 1)
                    }.buttonStyle(.bordered)
                    if let audio = event["audio_asset_id"].string {
                        Button(event["audio_is_mock"].bool ? tr("播放示例音频") : tr("播放配音")) { Task { await perform {
                            let data = try await model.bytes(base + ["tts", "audio", audio])
                            player?.stop(); player = try AVAudioPlayer(data: data); player?.play()
                        } } }
                    } else { Text(tr("此段暂无已生成配音")).font(.caption) }
                    Button(tr("关闭回放")) { player?.stop(); events = [] }
                }
            }
            Section(tr("已有演出")) {
                ForEach(presentations) { item in
                    DisclosureGroup(item.name) {
                    Button(tr("开始回放")) { Task { await perform {
                        let v = try await model.get(base + ["presentations", item.id])
                        let progress = try await model.get(base + ["presentations", item.id, "progress"])
                        performanceScenes = v["scenes"].array; events = v["events"].array.filter { !$0["hidden"].bool }; presentationId = item.id
                        index = min(max(0, progress["position"].int), max(0, events.count - 1))
                    } } }
                    NavigationLink(tr("配音选角")) { DubbingView(model: model, presentationId: item.id) }
                    Button(tr("下载独立播放包")) { Task { await perform {
                        let data = try await model.bytes(base + ["presentations", item.id, "bundle.zip"])
                        let url = FileManager.default.temporaryDirectory.appendingPathComponent("novel-\(UUID()).zip")
                        try data.write(to: url, options: .atomic); exported = url
                    } } }
                }
                }
                if presentations.isEmpty { Text(tr("暂无已发布到当前账号的演出")) }
            }
            Section(tr("战役日志")) {
                Text(tr("Events") + " · \(log["project"]["event_count"].int)")
                ForEach(["json", "txt", "html", "zip"], id: \.self) { format in
                    Button(tr("导出 ") + format.uppercased()) { Task { await exportLog(format) } }
                }
                ForEach(Array(log["windows"].array.enumerated()), id: \.offset) { _, window in
                    Button(tr("海豹 JSON · ") + window["name"].text) { Task { await exportLog("sealdice", window: window["id"].text) } }
                }
                NavigationLink(tr("制作视觉小说")) { NovelCreator(model: model) }
            }
            Section(tr("PDF 文件")) {
                ForEach(pdfJobs) { job in
                    if job["status"].text == "completed" {
                        Button(tr("Download") + " PDF · \(job.name.isEmpty ? job["created_at"].text : job.name)") { Task { await perform {
                            let data = try await model.bytes(base + ["pdf", "jobs", job.id, "file"])
                            let url = FileManager.default.temporaryDirectory.appendingPathComponent("log-\(UUID()).pdf")
                            try data.write(to: url, options: .atomic); exported = url
                        } } }
                    } else { Text("PDF · \(job["status"].text)").font(.caption) }
                }
                if pdfJobs.isEmpty { Text(tr("暂无 PDF，请先在 Log Studio 完成排版与渲染")) }
            }
            }
            if let exported { Section(tr("导出完成")) { ShareLink(tr("分享导出文件"), item: exported) } }
        }.navigationTitle(tr("故事回放")).navigationBarTitleDisplayMode(.inline)
            .task(id: model.channelId) { await reload() }
            .refreshable { await reload() }
            .onDisappear { player?.stop() }
    }
    private var base: [String] { ["channels", model.channelId, "studio"] }
    private func perform(_ work: () async throws -> Void) async {
        guard !loading else { return }; loading = true; errorText = ""; defer { loading = false }
        do { try await work() } catch { errorText = error is ClientError ? error.localizedDescription : tr("日志加载失败，请重试") }
    }
    private func reload() async {
        player?.stop(); events = []; exported = nil
        await perform {
            guard !model.channelId.isEmpty else { return }
            guard model.studioAvailable else { errorText = tr("日志制作已被服务器管理员或 GM 关闭"); return }
            log = try await model.get(base + ["log"])
            presentations = try await model.typed(base + ["presentations"])
            pdfJobs = try await model.typed(base + ["pdf", "jobs"])
        }
    }
    private func move(_ delta: Int) {
        player?.stop(); index += delta
        let position = index; let id = presentationId
        Task { await perform { _ = try await model.get(base + ["presentations", id, "progress"], body: .object(["position": .number(Double(position))])) } }
    }
    private func exportLog(_ format: String, window: String = "") async {
        await perform {
            var query = ["format": format]
            if !window.isEmpty { query["chat_window_id"] = window }
            let data = try await model.bytes(base + ["log", "export"], query: query)
            let ext = format == "sealdice" ? "json" : format
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("campaign-\(UUID()).\(ext)")
            try data.write(to: url, options: .atomic); exported = url
        }
    }
}

struct AuthenticatedArtwork: View {
    @ObservedObject var model: AppModel
    let assetId: String
    let version: Int
    @State private var data: Data?
    var body: some View {
        Group {
            if let data, let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit() }
            else { Text(tr("素材加载中或不可用")).font(.caption).foregroundStyle(.secondary) }
        }.task(id: assetId + String(version)) {
            data = nil
            data = try? await model.bytes(["channels", model.channelId, "media", assetId], query: version > 0 ? ["v": String(version)] : [:])
        }
    }
}
