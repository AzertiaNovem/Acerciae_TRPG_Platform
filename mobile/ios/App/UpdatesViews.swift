import SwiftUI
import AcerciaeCore
import UniformTypeIdentifiers

struct ScenarioControls: View {
    @ObservedObject var model: AppModel
    @State private var title = ""
    @State private var location = ""
    @State private var time = ""
    @State private var confirm = false
    var body: some View {
        Section(tr("下一阶段")) {
            TextField(tr("标题"), text: $title); TextField(tr("地点"), text: $location); TextField(tr("故事时间"), text: $time)
            Text(tr("开启后，所有聊天窗口一起进入新阶段，上一阶段关闭并生成摘要。")).font(.caption).foregroundStyle(.secondary)
            Button(tr("准备阶段，稍后进入")) { Task { await save(advance: false) } }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
            Button(tr("立即开启下一阶段")) { confirm = true }.disabled(model.busy)
        }.confirmationDialog(tr("所有聊天窗口将进入下一阶段"), isPresented: $confirm, titleVisibility: .visible) { Button(tr("开启下一阶段")) { Task { await save(advance: true) } } } message: {
            Text((model.scenes.first { $0.id == model.channel["current_scene_id"].text }?.name ?? "") + " → " + (title.isEmpty ? tr("下一阶段") : title) + "\n" + location + " · " + time + "\n" + tr("This cannot be undone."))
        }
    }
    private func save(advance: Bool) async {
        await model.run {
            _ = try await model.get(["channels", model.channelId] + (advance ? ["scenarios", "advance"] : ["scenes"]), body: .object(["title": .string(title), "location": .string(location), "narrative_time": .string(time)]))
            try await model.refresh(); title = ""; location = ""; time = ""
        }
    }
}
struct NovelCreator: View {
    @ObservedObject var model: AppModel
    @Environment(\.scenePhase) private var phase
    @State private var status: JSONValue = .null
    @State private var jobs: [Resource] = []
    @State private var title = ""
    @State private var instructions = ""
    @State private var scope = "pl_public"
    @State private var character = ""
    @State private var template = "adv"
    @State private var cloud = false
    @State private var art = false
    private var base: [String] { ["channels", model.channelId, "studio", "vn-scripts"] }
    var body: some View {
        Form {
            Section(tr("从战役日志制作")) {
                TextField(tr("作品标题"), text: $title)
                Picker(tr("可见范围"), selection: $scope) {
                    if model.gm { Text(tr("GM 完整视角")).tag("gm_full") }
                    Text(tr("公共内容")).tag("pl_public")
                    if !model.playable.isEmpty { Text(tr("角色视角")).tag("character") }
                }
                if scope == "character" { Picker(tr("角色"), selection: $character) { ForEach(model.playable) { Text($0.name).tag($0.id) } } }
                Picker(tr("模板"), selection: $template) { Text(tr("经典对话")).tag("adv"); Text(tr("小说页面")).tag("nvl"); Text(tr("调查档案")).tag("dossier"); Text(tr("电影字幕")).tag("cinematic") }
                TextField(tr("改编方向（可选）"), text: $instructions, axis: .vertical)
                Text(status["mock"].bool ? tr("当前使用示例生成服务") : status["note"].text).font(.caption)
                if !status["mock"].bool { Toggle(tr("同意将选定日志发送至配置的云端服务"), isOn: $cloud).disabled(!status["cloud_allowed"].bool) }
                Toggle(tr("同时生成缺失的背景与立绘"), isOn: $art).disabled(!status["images"].bool)
                Button(tr("生成视觉小说")) { Task { await model.run {
                    var body: [String: JSONValue] = ["scope": .string(scope), "template": .object(["base": .string(template)]), "allow_cloud": .bool(cloud), "generate_art": .bool(art), "instructions": .string(instructions)]
                    if !title.isEmpty { body["title"] = .string(title) }
                    if scope == "character" { body["scope_character_id"] = .string(character) }
                    _ = try await model.get(base, body: .object(body)); try await load()
                } } }.disabled(model.busy || status == .null || (!status["mock"].bool && (!cloud || !status["cloud_allowed"].bool)) || (scope == "character" && character.isEmpty))
            }
            Section(tr("生成任务")) {
                ForEach(jobs) { job in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(job.name.isEmpty ? tr("视觉小说") : job.name).font(.headline)
                        Text("\(job["status"].text) · \(job["progress"]["chunks_done"].int) / \(job["progress"]["chunks_total"].int)")
                        if !job["error"].text.isEmpty { Text(job["error"].text).foregroundStyle(.orange) }
                        if ["pending", "running"].contains(job["status"].text) { Button(tr("取消生成")) { Task { await model.run { _ = try await model.get(base + [job.id, "cancel"], body: .object([:])); try await load() } } }.disabled(model.busy) }
                        if !job["presentation_id"].text.isEmpty { Text(tr("已完成，可返回故事回放查看并下载独立播放包")).font(.caption) }
                    }
                }
            }
        }.navigationTitle(tr("制作视觉小说"))
            .task {
                character = model.playable.first?.id ?? ""; scope = model.gm ? "gm_full" : (character.isEmpty ? "pl_public" : "character")
                await model.run { status = try await model.get(base + ["status"]); try await load() }
            }
            .task(id: phase) {
                guard phase == .active else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(4)); if jobs.contains(where: { ["pending", "running"].contains($0["status"].text) }) { try await load() } }
                    catch { return }
                }
            }
    }
    private func load() async throws { jobs = try await model.typed(base) }
}

struct CharacterSpace: View {
    @ObservedObject var model: AppModel
    let character: Resource
    @State private var space: JSONValue = .null
    @State private var card: [String: JSONValue] = [:]
    @State private var pointRules: JSONValue = .null
    @State private var rulesError = ""
    @State private var name = ""
    @State private var bio = ""
    @State private var speakingStyle = ""
    @State private var prompt = ""
    @State private var mode = "uploaded"
    @State private var importing = false
    @State private var slot = "portrait"
    @State private var subtitle = "IDLE"
    @State private var cloud = false
    private var base: [String] { ["channels", model.channelId, "characters", character.id] }
    private var editable: Bool { space["character"]["editable"].bool && !model.busy }
    private var pointsOn: Bool { space["points"]["enabled"].bool }
    private var pointsValid: Bool { !pointsOn || (pointRules != .null && PointBuy(card: .object(card), rules: pointRules).issues.isEmpty) }
    private let groups: [(String, String, [String])] = [
        ("basic", tr("基本信息"), ["player", "occupation", "age", "sex", "residence", "birthplace"]),
        ("characteristics", tr("CoC7 属性"), ["STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUK"]),
        ("derived", tr("状态"), ["hp", "hp_max", "mp", "mp_max", "san", "san_max", "mov", "build", "db"]),
        ("background", tr("人物背景"), ["personal_description", "ideology", "significant_people", "meaningful_locations", "treasured_possessions", "traits", "injuries", "phobias", "arcane", "encounters"]),
        ("wealth", tr("财产"), ["cash", "assets", "spending_level"])]
    var body: some View {
        Form {
            Section(tr("角色资料")) { TextField(tr("姓名"), text: $name); TextField(tr("简介"), text: $bio, axis: .vertical); TextField(tr("说话风格"), text: $speakingStyle, axis: .vertical) }.disabled(!editable)
            ForEach(groups, id: \.0) { group in
                DisclosureGroup(group.1) {
                    ForEach(group.2, id: \.self) { field in
                        LabeledContent(fieldLabel(field)) { TextField(fieldLabel(field), text: binding(group.0, field), axis: .vertical).multilineTextAlignment(.trailing) }.disabled(!editable)
                    }
                }
            }
            if pointsOn {
                if pointRules != .null { PointBuyEditor(card: $card, rules: pointRules, editable: editable, isKeeper: model.gm, language: space["points"]["language"].string ?? model.serverSettings["language"].text) }
                else { Section(tr("CoC7 购点")) { Text(rulesError.isEmpty ? tr("正在读取职业和技能规则…") : rulesError); Button(tr("重新加载规则")) { Task { await loadRules() } } } }
            } else { DisclosureGroup(tr("技能")) {
                ForEach((card["skills"]?.object ?? [:]).keys.sorted(), id: \.self) { field in TextField(field, text: binding("skills", field)).disabled(!editable) }
            }
            }
            DisclosureGroup(tr("随身物品")) {
                ForEach(Array((card["items"]?.array ?? []).enumerated()), id: \.offset) { _, item in Text("\(item["name"].text) × \(item["qty"].int)\n\(item["note"].text)") }
            }
            Section(tr("外观")) {
                Text("\(space["era"].text) · \(space["narrative_time"].text)").font(.caption)
                ForEach(["avatar", "portrait"], id: \.self) { slot in
                    if !space[slot]["id"].text.isEmpty { AuthenticatedArtwork(model: model, assetId: space[slot]["id"].text, version: space[slot]["version"].int).frame(height: slot == "avatar" ? 80 : 220) }
                }
                ForEach(Array(space["subtitles"].array.enumerated()), id: \.offset) { _, asset in
                    Text(asset["subtitle"].text); AuthenticatedArtwork(model: model, assetId: asset["id"].text, version: asset["version"].int).frame(height: 180)
                }
                if editable {
                    Picker(tr("素材来源"), selection: $mode) { Text(tr("上传素材")).tag("uploaded"); Text(tr("生成素材")).tag("generated") }
                    TextField(tr("外观与统一画风描述"), text: $prompt, axis: .vertical)
                    Button(tr("保存外观设置")) { Task { await model.run { space = try await model.get(base + ["appearance"], body: .object(["asset_mode": .string(mode), "appearance_prompt": .string(prompt)]), method: "PUT") } } }.disabled(model.busy)
                    if mode == "uploaded" {
                        Picker(tr("上传到"), selection: $slot) { Text(tr("头像")).tag("avatar"); Text(tr("主立绘")).tag("portrait"); Text(tr("表情立绘")).tag("subtitle") }
                        if slot == "subtitle" { TextField(tr("表情名称，如 IDLE"), text: $subtitle) }
                        Button(tr("选择图片并上传")) { importing = true }.disabled(model.busy || (slot == "subtitle" && subtitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    }
                    if mode == "generated" {
                        Toggle(tr("允许本次生成使用云端服务"), isOn: $cloud)
                        Button(tr("生成头像与主立绘")) { Task { await model.run {
                            _ = try await model.get(base + ["appearance"], body: .object(["asset_mode": .string(mode), "appearance_prompt": .string(prompt)]), method: "PUT")
                            _ = try await model.get(base + ["assets", "generate"], body: .object(["slots": .array([.string("portrait"), .string("avatar")]), "allow_cloud": .bool(cloud)]))
                            space = try await model.get(base + ["space"])
                        } } }.disabled(model.busy || !space["generation_available"].bool || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                ForEach(Array(space["jobs"].array.enumerated()), id: \.offset) { _, job in Text("\(job["kind"].text) · \(job["status"].text)\n\(job["error"].text)").font(.caption) }
                Button(tr("刷新素材")) { Task { await model.run { space = try await model.get(base + ["space"]) } } }.disabled(model.busy)
            }
        }.fileImporter(isPresented: $importing, allowedContentTypes: [.png, .jpeg], allowsMultipleSelection: false) { result in
            Task { await model.run {
                guard let url = try result.get().first else { return }
                let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 10 * 1024 * 1024 else { model.notice = tr("请选择小于 10 MB 的图片"); return }
                space = try await model.uploadArtwork(Data(contentsOf: url), character: character.id, slot: slot, subtitle: subtitle)
            } }
        }.navigationTitle(tr("角色空间"))
            .toolbar { ToolbarItem(placement: .confirmationAction) { if space["character"]["editable"].bool { Button(tr("保存")) { Task { await saveCard() } }.disabled(!editable || !pointsValid || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } } }
            .task { do { apply(try await model.get(base + ["space"])) } catch { model.handle(error) }; if pointsOn { await loadRules() } }
    }
    private func saveCard() async {
        await model.run {
            let updated = try await model.get(base + ["card"], body: .object(["name": .string(name), "bio": .string(bio), "speaking_style": .string(speakingStyle), "role_card": .object(card)]), method: "PUT")
            apply(updated); try await model.refresh(); model.notice = tr("角色卡已保存")
        }
    }
    private func loadRules() async {
        do { pointRules = try await model.get(["coc7", "rules"]); rulesError = "" }
        catch { rulesError = tr("职业规则暂不可用，请重试；草稿保留") }
    }
    private func apply(_ value: JSONValue) { space = value; card = value["character"]["role_card"].object; name = value["character"]["name"].text; bio = value["character"]["bio"].text; speakingStyle = value["character"]["speaking_style"].text; mode = value["character"]["asset_mode"].text; prompt = value["character"]["appearance_prompt"].text }
    private func binding(_ group: String, _ key: String) -> Binding<String> {
        Binding(get: { let value = card[group]?[key] ?? .null; return value.string ?? (value == .null ? "" : String(value.int)) }, set: { text in
            var section = card[group]?.object ?? [:]
            let numeric = group == "characteristics" || group == "skills" || (group == "derived" && key != "db")
            if numeric { if text.isEmpty { section.removeValue(forKey: key) } else if let number = Int(text), (-99...999).contains(number) { section[key] = .number(Double(number)) } }
            else { section[key] = .string(text) }; card[group] = .object(section)
        })
    }
}
private func fieldLabel(_ key: String) -> String {
    ["player":tr("玩家"), "occupation":tr("职业"), "age":tr("年龄"), "sex":tr("性别"), "residence":tr("现居地"), "birthplace":tr("出生地"), "personal_description":tr("外貌描述"), "ideology":tr("思想信念"), "significant_people":tr("重要之人"), "meaningful_locations":tr("重要之地"), "treasured_possessions":tr("宝贵之物"), "traits":tr("特质"), "injuries":tr("伤病"), "phobias":tr("恐惧与狂躁"), "arcane":tr("神秘知识"), "encounters":tr("离奇遭遇"), "cash":tr("现金"), "assets":tr("资产"), "spending_level":tr("消费水平")][key] ?? key.uppercased()
}

struct DubbingView: View {
    @ObservedObject var model: AppModel
    let presentationId: String
    @State private var presentation: JSONValue = .null
    @State private var voices: [Resource] = []
    @State private var presets: [Resource] = []
    @State private var cast: [String: JSONValue] = [:]
    @State private var estimate: JSONValue = .null
    @State private var job: JSONValue = .null
    @Environment(\.scenePhase) private var phase
    private var base: [String] { ["channels", model.channelId, "studio"] }
    private var speakers: [String: String] {
        var result = ["narrator": tr("旁白")]
        for event in presentation["events"].array where !event["hidden"].bool && !event["speaker_character_id"].text.isEmpty { result[event["speaker_character_id"].text] = event["speaker_display_name"].text }
        return result
    }
    var body: some View {
        Form {
            Section(tr("演出配音")) {
                ForEach(speakers.keys.sorted(), id: \.self) { id in
                    Picker(speakers[id] ?? tr("角色"), selection: Binding(get: { cast[id]?.text ?? "" }, set: { cast[id] = .string($0); estimate = .null })) {
                        Text(tr("不配音")).tag("")
                        ForEach(voices.filter { $0["character_id"].text.isEmpty || $0["character_id"].text == id }) { voice in Text(voice.name).tag(voice.id) }
                    }
                }
                Menu(tr("添加预设音色")) { ForEach(presets) { preset in Button(preset.name) { Task { await model.run {
                    _ = try await model.get(base + ["voices"], body: .object(["name": .string(preset.name), "voice_type": .string("preset"), "voice_id": .string(preset.id)]))
                    voices = try await model.typed(base + ["voices"])
                } } } } }
                Button(tr("保存选角并估算配音")) { Task { await model.run {
                    presentation = try await model.get(base + ["presentations", presentationId, "cast"], body: .object(["cast": .object(cast)]))
                    estimate = try await model.get(base + ["presentations", presentationId, "tts", "estimate"], body: .object([:]))
                } } }.disabled(model.busy)
            }
            if estimate != .null {
                Section(tr("生成前确认")) {
                    Text(tr("Characters (count)") + " \(estimate["chars"].int) · " + tr("Lines") + " \(estimate["lines_to_synthesize"].int)")
                    Text(estimate["mock"].bool ? tr("示例服务，无真实配音费用") : tr("将使用服务器配置的配音服务，可能产生费用；实际金额由服务商结算。"))
                    if !estimate["within_budget"].bool { Text(tr("超过战役字符预算")) }
                    Button(tr("确认生成配音")) { Task { await model.run {
                        job = try await model.get(base + ["presentations", presentationId, "tts", "jobs"], body: .object([:])); estimate = .null
                    } } }.disabled(model.busy || !estimate["within_budget"].bool || estimate["lines_to_synthesize"].int == 0)
                }
            }
            if job != .null { Section(tr("配音任务")) { Text(job["status"].text); Text(job["error"].text) } }
        }.navigationTitle(tr("配音选角"))
            .task { await model.run {
                presentation = try await model.get(base + ["presentations", presentationId]); cast = presentation["settings"]["cast"].object
                voices = try await model.typed(base + ["voices"]); presets = try await model.typed(base + ["tts", "available-voices"])
            } }
            .task(id: phase) {
                guard phase == .active else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(3)); if ["pending", "running"].contains(job["status"].text) { job = try await model.get(base + ["tts", "jobs", job["id"].text]) } } catch { return }
                }
            }
    }
}
