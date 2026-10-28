import SwiftUI
import AcerciaeCore

private let ink = Color(red: 0.07, green: 0.086, blue: 0.098)
private let panelColor = Color(red: 0.14, green: 0.165, blue: 0.18)
private let accent = Color(red: 0.79, green: 0.85, blue: 0.74)

struct RootView: View {
    @StateObject private var model = AppModel()
    @ObservedObject private var locale = MobileLocale.shared
    @State private var page = "chat"
    @State private var sidebarOpen = false
    @State private var dragOffset: CGFloat = 0
    @State private var detail: SidebarDetail?
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Group {
            if !model.online { NavigationStack { AuthenticationView(model: model) } }
            else { GeometryReader { geometry in
            let width = min(320, geometry.size.width * 0.64)
            let reveal = min(width, max(0, (sidebarOpen ? width : 0) + dragOffset))
            ZStack(alignment: .leading) {
                NavigationStack {
                    Group {
                        switch page {
                        case "replay": if model.online { StudioView(model: model).id(model.scopeKey + model.studioAccess + model.channel["story_status"].text + String(model.channel["story_reveal_all"].bool)) } else { ReplayView(campaign: model.campaign) }
                        case "server": LiveServerView(model: model).id(model.serverId)
                        case "channel": LiveChannelView(model: model).id(model.channelId)
                        case "settings": SettingsView(model: model)
                        default: ChatView(model: model)
                        }
                    }
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button {
                                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                                withAnimation(.easeOut(duration: 0.22)) { sidebarOpen = true }
                            } label: { Image(systemName: "line.3.horizontal").frame(minWidth: 32, minHeight: 44) }
                            .accessibilityLabel(tr("打开侧栏"))
                        }
                    }
                }
                .accessibilityHidden(reveal > 0)

                if reveal > 0 {
                    Color.black.opacity(0.42 * reveal / width).ignoresSafeArea()
                        .onTapGesture { closeSidebar() }
                        .accessibilityLabel(tr("关闭侧栏")).accessibilityAddTraits(.isButton)
                        .gesture(sidebarDrag(width: width))
                }
                if !sidebarOpen {
                    Color.clear.frame(width: 22).contentShape(Rectangle())
                        .gesture(sidebarDrag(width: width)).accessibilityHidden(true)
                }
                if reveal > 0 {
                    SidebarView(model: model, page: page, select: { destination in
                        page = destination; closeSidebar()
                    }, showDetail: { item in
                        closeSidebar(); detail = item
                    }, close: closeSidebar)
                    .frame(width: width).frame(maxHeight: .infinity)
                    .background(panelColor.ignoresSafeArea())
                    .offset(x: reveal - width)
                    .simultaneousGesture(sidebarDrag(width: width))
                    .accessibilityAction(.escape) { closeSidebar() }
                }
            }.background(ink)
        }
        } }
        .id(locale.language)
        .environment(\.locale, Locale(identifier: locale.language))
        .onChange(of: model.online) { _, _ in page = "chat"; sidebarOpen = false; dragOffset = 0; detail = nil }
        .task(id: "\(model.session?.user.id ?? "")-\(scenePhase)") {
            guard model.online, scenePhase == .active else { return }
            await model.poll(forceCatalog: true)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(4)) } catch { break }
                await model.poll()
            }
        }
        .tint(accent)
        .sheet(item: $detail) { item in
            NavigationStack {
                ScrollView { Text(item.body).frame(maxWidth: .infinity, alignment: .leading).padding(24) }
                    .navigationTitle(item.title).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button(tr("完成")) { detail = nil } } }
            }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        .alert(tr("提示"), isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button(tr("知道了")) { model.notice = nil }
        } message: { Text(model.notice ?? "") }
    }
    private func closeSidebar() {
        withAnimation(.easeOut(duration: 0.22)) { sidebarOpen = false; dragOffset = 0 }
    }
    private func sidebarDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 16)
            .onChanged { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                dragOffset = sidebarOpen ? min(0, value.translation.width) : max(0, value.translation.width)
            }
            .onEnded { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { dragOffset = 0; return }
                let projected = (sidebarOpen ? width : 0) + value.predictedEndTranslation.width
                withAnimation(.easeOut(duration: 0.22)) { sidebarOpen = projected > width * 0.4; dragOffset = 0 }
            }
    }
}

private struct SidebarDetail: Identifiable {
    var id: String { title }
    let title: String
    let body: String
}

private struct SidebarView: View {
    @ObservedObject var model: AppModel
    let page: String
    let select: (String) -> Void
    let showDetail: (SidebarDetail) -> Void
    let close: () -> Void
    @State private var browsingServers = false
    @State private var creatingChannel = false
    @State private var creatingCharacter = false
    @State private var selectedCharacter: Resource?
    @State private var selectedScene: Resource?
    @State private var charactersExpanded = true
    @State private var scenesExpanded = true
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Acerciae").font(.title3.weight(.semibold))
                Spacer()
                Button(action: close) { Image(systemName: "xmark").frame(width: 44, height: 44) }
                    .accessibilityLabel(tr("关闭侧栏"))
            }.padding(.horizontal, 16)
            if model.online {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Menu(model.serverName) {
                            ForEach(model.servers) { server in Button(server.name) { Task { await model.run { try await model.selectServer(server.id) } } } }
                        }.font(.headline)
                        row(tr("Servers"), icon: "globe") { browsingServers = true }
                        if model.serverSettings["is_maintainer"].bool { row(tr("服务器选项"), icon: "server.rack") { select("server") } }
                        HStack {
                            Text(tr("频道")).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button { creatingChannel = true } label: { Image(systemName: "plus") }.accessibilityLabel(tr("添加频道")).disabled(model.serverId.isEmpty || !model.canCreateChannel)
                        }
                        ForEach(model.channels) { item in
                            row(item.name, icon: "number", selected: model.channelId == item.id) { Task { await model.run { try await model.selectChannel(item.id) } } }
                        }
                        if model.gm { row(tr("频道选项"), icon: "slider.horizontal.3") { select("channel") } }
                        Text(tr("聊天窗口")).font(.caption).foregroundStyle(.secondary)
                        ForEach(model.windows) { item in
                            row(item.name, icon: "bubble.left", selected: model.windowId == item.id) { Task { await model.run { try await model.selectWindow(item.id); select("chat") } } }
                        }
                        DisclosureGroup(tr("角色"), isExpanded: $charactersExpanded) {
                            if !model.channelId.isEmpty { row(tr("添加角色"), icon: "person.badge.plus") { creatingCharacter = true } }
                            ForEach(model.characters) { item in
                                Button { model.result = nil; selectedCharacter = item } label: {
                                    HStack(spacing: 10) {
                                        AvatarView(model: model, name: item.name, assetId: item["avatar_asset_id"].text, version: item["updated_at"].text)
                                        Text(item.name).frame(maxWidth: .infinity, alignment: .leading)
                                    }.padding(.vertical, 6)
                                }.buttonStyle(.plain)
                            }
                        }
                        DisclosureGroup(tr("阶段"), isExpanded: $scenesExpanded) {
                            ForEach(model.scenes) { item in row(item.name, icon: "circle") { selectedScene = item } }
                        }
                        if model.windows.isEmpty { Text(tr("No chat windows you can read.")).font(.caption) }
                    }.padding(16).disabled(model.busy)
                }
                .sheet(isPresented: $browsingServers) { NavigationStack { ServerBrowser(model: model) } }
                .sheet(isPresented: $creatingChannel) { NavigationStack { CreateChannelView(model: model, serverId: model.serverId) } }
                .sheet(isPresented: $creatingCharacter) { NavigationStack { CreateCharacterView(model: model, channelId: model.channelId) } }
                .fullScreenCover(item: $selectedCharacter) { item in NavigationStack { CharacterView(model: model, character: item).id(model.scopeKey) } }
                .sheet(item: $selectedScene) { item in NavigationStack { SceneView(model: model, scene: item).id(model.scopeKey) } }
            } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Button {
                        showDetail(SidebarDetail(title: tr("服务器"), body: "Arkham Table\n当前战役：黑水湾的提灯\n\n当前为本地演示。服务器切换、管理员设置和功能开关将在联网后接入，频道 GM 与服务器管理员权限分别处理。"))
                    } label: {
                        HStack(alignment: .top) {
                            Image(systemName: "server.rack")
                            VStack(alignment: .leading, spacing: 5) {
                                Text("Arkham Table").font(.subheadline.weight(.semibold))
                                Text(tr("服务器选项")).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.down").font(.caption)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text(tr("聊天窗口")).font(.caption).foregroundStyle(.secondary)
                        row(tr("主聊天"), icon: "bubble.left", selected: page == "chat") { select("chat") }
                        Text(model.campaign?.title ?? "黑水湾的提灯").font(.caption).foregroundStyle(.secondary)
                    }
                    DisclosureGroup(tr("角色"), isExpanded: $charactersExpanded) {
                        VStack(spacing: 2) {
                            row("哈维 · 我", icon: "person.crop.circle") {
                                showDetail(SidebarDetail(title: "哈维", body: "当前演示角色 · 古物学教授\n由 Alice 操作。正式角色卡与属性编辑将在联网后接入。"))
                            }
                            row("托马斯", icon: "person.crop.circle") {
                                showDetail(SidebarDetail(title: "托马斯", body: "示例角色 · 退役水手\n由 Carol 操作，昨夜独自调查了码头。"))
                            }
                            row(tr("守秘人"), icon: "person.crop.circle") {
                                showDetail(SidebarDetail(title: tr("守秘人"), body: "频道 GM\n负责场景叙述与裁定；频道 GM 身份不等于服务器管理员。"))
                            }
                        }.padding(.top, 6)
                    }.font(.subheadline)
                    DisclosureGroup(tr("阶段"), isExpanded: $scenesExpanded) {
                        VStack(spacing: 2) {
                            row("警署初访", icon: "circle") {
                                showDetail(SidebarDetail(title: "警署初访", body: "第一幕 · 历史阶段\n调查员在警长桌上发现提灯徽章，警长答应送来灯塔钥匙。\n\n此处仅浏览阶段摘要，不改变当前游戏阶段。"))
                            }
                            row("分头调查", icon: "circle") {
                                showDetail(SidebarDetail(title: "分头调查", body: "第二幕 · 历史阶段\n调查员分头前往报社与码头。正式内容将按各自知识权限加载。"))
                            }
                            row("寄宿屋 · 当前", icon: "circle.inset.filled") {
                                showDetail(SidebarDetail(title: "海尔寄宿屋", body: model.campaign?.documents.first { $0.docType == "current_scene" }?.preview ?? "第三幕 · 调查员重聚"))
                            }
                        }.padding(.top, 6)
                    }.font(.subheadline)
                }.padding(16)
            }
            }
            Divider()
            VStack(spacing: 0) {
                row(tr("故事回放"), icon: "play.rectangle", selected: page == "replay") { select("replay") }
                row(tr("设置"), icon: "slider.horizontal.3", selected: page == "settings") { select("settings") }
                Text(model.online ? "\(model.session?.user.displayName ?? "") · \(model.gm ? "GM" : tr("Player"))" : "本地演示 · 内容不上传").font(.caption2).foregroundStyle(.secondary).padding(.vertical, 10)
            }.padding(.horizontal, 16).padding(.top, 8)
        }
    }
    private func row(_ title: String, icon: String, selected: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon).font(.subheadline).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 8).background(selected ? accent.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain).foregroundStyle(selected ? accent : .primary)
    }
}

private enum ContextPanel: String, Identifiable { case documents = "documents", hints = "hints"; var id: String { rawValue } }
private struct ChatView: View {
    @ObservedObject var model: AppModel
    @State private var contextPanel: ContextPanel?
    var body: some View {
        Group {
            if let campaign = model.campaign {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 20) {
                            Text(campaign.scene).font(.caption).foregroundStyle(accent)
                            if model.online && model.hasOlder { Button(tr("加载更早消息")) { Task { await model.older() } }.disabled(model.busy) }
                            ForEach(campaign.messages) { MessageBubble(message: $0, model: model).id($0.id) }
                        }.padding(16)
                    }
                    .onAppear { if let id = campaign.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
                    .refreshable { await model.poll() }
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: campaign.messages.last?.id) { _, _ in
                        if let id = campaign.messages.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { Composer(model: model) }
                .navigationTitle(model.online ? model.windowName : campaign.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button(tr("考据")) { contextPanel = .documents }
                        Button(tr("Reminders") + " \(model.online ? model.reminders.count : campaign.highlights.count)") { contextPanel = .hints }
                    }
                }
                .sheet(item: $contextPanel) { panel in ContextSheet(model: model, campaign: campaign, panel: panel).id(model.channelId + model.channel["player_group_id"].text + String(model.channel["player_group_version"].int) + String(model.gm)) }
            } else { ContentUnavailableView(model.servers.isEmpty ? tr("尚未加入服务器") : tr("从侧栏选择频道和聊天窗口"), systemImage: "bubble.left", description: Text(model.servers.isEmpty ? tr("Ask a server administrator to invite your account: {username}").replacingOccurrences(of: "{username}", with: model.session?.user.username ?? "") : tr("选择一个频道开始聊天"))) }
        }
        .background(ink)
    }
}

private struct MessageBubble: View {
    let message: Message
    @ObservedObject var model: AppModel
    private var mine: Bool { message.authorId != nil && message.authorId == model.session?.user.id }
    private var name: String { message.characterName ?? message.authorName }
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if mine { Spacer(minLength: 36) } else { avatar }
            VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
                Text(name + (mine ? " · " + tr("Me") : message.kind == "narration" ? " · GM" : ""))
                    .font(.caption).foregroundStyle(.secondary)
                if message.dice != nil { DiceResultView(message: message) } else {
                Text(message.displayText)
                    .textSelection(.enabled)
                    .padding(14)
                    .background(mine ? Color(red: 0.21, green: 0.26, blue: 0.22) : panelColor,
                        in: UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: mine ? 18 : 5,
                                                   bottomTrailingRadius: mine ? 5 : 18, topTrailingRadius: 18))
                }
            }
            if mine { avatar } else { Spacer(minLength: 36) }
        }
    }
    private var avatar: some View {
        let character = model.characters.first { $0.id == message.characterId }
        let asset = character.map { $0["avatar_asset_id"].text } ?? message.characterAvatarAssetId ?? ""
        let revision = (character?["updated_at"].text ?? "") + ":" + String(message.characterAvatarVersion ?? 0)
        return AvatarView(model: model, name: name, assetId: asset, version: revision, ownerId: message.authorId ?? "", ownerVersion: message.authorAvatarVersion ?? 0)
    }
}

private struct Composer: View {
    @ObservedObject var model: AppModel
    @State private var assistanceType = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(tr("What does your character do or say?"), text: $model.draft, axis: .vertical)
                .lineLimit(1...5).padding(.horizontal, 6).padding(.top, 6)
            if !model.diceHint.isEmpty { Text(model.diceHint).font(.caption).foregroundStyle(.secondary) }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { roleMenu; assistance; Spacer(minLength: 0); sendButton }
                VStack(spacing: 10) {
                    HStack { roleMenu; Spacer(); sendButton }
                    HStack { assistance; Spacer() }
                }
            }
        }
        .task(id: "\(model.draft)-\(model.characterId)") {
            do { try await Task.sleep(for: .milliseconds(400)); await model.previewDice() } catch {}
        }
        .sheet(isPresented: Binding(get: { model.result != nil }, set: { if !$0 { model.result = nil } })) {
            NavigationStack {
                ScrollView { Text(model.result ?? "").frame(maxWidth: .infinity, alignment: .leading).padding(24) }
                    .navigationTitle(assistanceType == "inspiration" ? tr("灵感草稿") : tr("一致性检查"))
                    .toolbar {
                        if assistanceType == "inspiration" { Button(tr("采用草稿")) { model.draft = model.result ?? ""; model.result = nil } }
                        Button(tr("关闭")) { model.result = nil }
                    }
            }
        }
        .padding(14).background(panelColor, in: RoundedRectangle(cornerRadius: 26))
        .padding(.horizontal, 12).padding(.vertical, 8).background(ink)
    }
    private var roleMenu: some View {
        Menu {
            if model.online {
                ForEach(model.playable) { item in Button(item.name) { model.chooseRole(item.id) } }
                Button(model.gm ? tr("旁白") : tr("场外")) { model.chooseRole("") }
            } else {
                Button("哈维") { model.role = "哈维" }
                Button(tr("旁白")) { model.role = tr("旁白") }
            }
        } label: { Label(model.characterId.isEmpty ? (model.gm ? tr("旁白") : tr("场外")) : model.role, systemImage: "chevron.down").font(.subheadline) }
    }
    private var assistance: some View {
        Group {
            Button(tr("一致性")) { assistanceType = "consistency"; Task { await model.assistance("consistency") } }.disabled(model.busy || !model.enabled("consistency") || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button(tr("灵感")) { assistanceType = "inspiration"; Task { await model.assistance("inspiration") } }.disabled(model.busy || !model.enabled("inspiration"))
        }.font(.subheadline).frame(minHeight: 44)
    }
    private var sendButton: some View {
        Button(action: model.sendDemo) { Image(systemName: "arrow.up").font(.body.bold()).frame(width: 44, height: 44) }
            .background(accent, in: Circle()).foregroundStyle(ink)
            .disabled(model.busy || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .opacity(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
            .accessibilityLabel(tr("发送"))
    }
}

private struct ContextSheet: View {
    @ObservedObject var model: AppModel
    @State private var fullDocument = ""
    let campaign: DemoCampaign
    let panel: ContextPanel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Text(model.online ? tr("按当前账号权限显示") : "本地演示 · 当前以 GM 视角浏览").font(.caption).foregroundStyle(.secondary)
                if model.online {
                    ReminderList(model: model)
                    if model.gm { NavigationLink(tr("KP 看板 · 剧本下一步与笔记")) { KeeperBoard(model: model) } }
                }
                if panel == .documents && (!model.online || model.gm) {
                    ForEach(campaign.documents) { document in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(document.title + (document.gmOnly == true ? " · GM" : "")).font(.headline)
                            Text(document.preview ?? "").font(.body)
                            Text("v\(document.version)").font(.caption).foregroundStyle(accent)
                            if model.online { Button(tr("阅读全文")) { Task { await model.run {
                                let value = try await model.get(["channels", model.channelId, "documents", document.id]); fullDocument = value["markdown"].text
                            } } } }
                        }.padding(.vertical, 6)
                    }
                } else if !model.online || model.gm {
                    ForEach(campaign.highlights) { hint in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(hint.reason).foregroundStyle(Color(red: 0.89, green: 0.85, blue: 0.56))
                            Text(campaign.documents.first { $0.id == hint.documentId }?.title ?? "").font(.caption)
                            ForEach(hint.sourceEventIds, id: \.self) { id in
                                if let message = campaign.messages.first(where: { $0.id == id }) {
                                    Text(tr("Source") + ": " + message.content).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }.padding(.vertical, 6)
                    }
                }
            }
            .sheet(isPresented: Binding(get: { !fullDocument.isEmpty }, set: { if !$0 { fullDocument = "" } })) { ScrollView { Text(fullDocument).textSelection(.enabled).padding(24) } }
            .navigationTitle(panel == .documents ? tr("考据") : tr("提示")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(tr("完成")) { dismiss() } } }
        }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}

private struct ReplayView: View {
    let campaign: DemoCampaign?
    @State private var index = 0
    var body: some View {
        VStack(spacing: 16) {
            if let frames = campaign?.replay, !frames.isEmpty {
                let frame = frames[min(index, frames.count - 1)]
                Text("视觉小说 · 模板预览").font(.headline).frame(maxWidth: .infinity, alignment: .leading)
                ZStack(alignment: .bottom) {
                    LinearGradient(colors: [Color(red: 0.14, green: 0.24, blue: 0.26), ink], startPoint: .top, endPoint: .bottom)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(frame.atmosphere).foregroundStyle(accent)
                        Text("背景与立绘待导入").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        VStack(alignment: .leading, spacing: 12) {
                            Text(frame.speaker).font(.headline).foregroundStyle(accent)
                            Text(frame.text).frame(maxWidth: .infinity, alignment: .leading)
                        }.padding(20).background(panelColor.opacity(0.95), in: RoundedRectangle(cornerRadius: 20))
                    }.padding(20)
                }.clipShape(RoundedRectangle(cornerRadius: 24))
                HStack {
                    Button(tr("上一段")) { index -= 1 }.disabled(index == 0)
                    Spacer(); Text("\(index + 1) / \(frames.count)"); Spacer()
                    Button(tr("下一段")) { index += 1 }.disabled(index >= frames.count - 1)
                }.buttonStyle(.bordered)
                Text("Qwen 语音、统一画风素材、海豹 JSON 和 PDF 导出将在服务端协议就绪后接入。")
                    .font(.caption).foregroundStyle(.secondary)
            } else { ContentUnavailableView(tr("暂无可回放内容"), systemImage: "play.rectangle") }
        }.padding(20).background(ink).navigationTitle(tr("故事回放")).navigationBarTitleDisplayMode(.inline)
    }
}

private struct SettingsView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        Form {
            Section(tr("账号")) {
                if let user = model.session?.user {
                    HStack(spacing: 12) { AvatarView(model: model, name: user.displayName, ownerId: user.id, ownerVersion: user.avatarVersion ?? 0, size: 48); Text(user.displayName) }
                    Text(user.username).foregroundStyle(.secondary)
                }
                Button(tr("退出登录"), role: .destructive) { model.logout() }.disabled(model.busy)
            }
            Section { LanguagePicker(model: model); Text(tr("This changes your interface only. Server AI output language stays unchanged.")).font(.caption) }
            Section(tr("内容同步")) {
                Button(tr("立即刷新")) { Task { await model.poll(forceCatalog: true) } }.disabled(model.busy)
                Text(tr(model.connection)).foregroundStyle(accent)
                Text(tr("聊天每 4 秒刷新，服务器与频道列表每 30 秒同步，回到前台立即更新。")).font(.caption)
            }
        }.navigationTitle(tr("设置")).navigationBarTitleDisplayMode(.inline)
    }
}

private struct AuthenticationView: View {
    @ObservedObject var model: AppModel
    @State private var registering = false
    @State private var username = ""
    @State private var displayName = ""
    @State private var password = ""
    @State private var confirmation = ""
    private var cleanUsername: String { username.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool {
        guard !cleanUsername.isEmpty && !password.isEmpty else { return false }
        return !registering || (cleanUsername.range(of: "^[a-zA-Z0-9_.-]{3,32}$", options: .regularExpression) != nil && password.count >= 6 && confirmation == password)
    }
    var body: some View {
        Form {
            Section {
                Text("Acerciae").font(.largeTitle.weight(.semibold))
                Text(registering ? tr("创建账号，加入你的跑团") : tr("登录账号，继续你的故事")).foregroundStyle(.secondary)
            }
            Section { LanguagePicker(model: model) }
            Section(registering ? tr("注册账号") : tr("登录")) {
                TextField(tr("用户名"), text: $username).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                if registering { TextField(tr("显示名称（选填）"), text: $displayName).textContentType(.nickname) }
                SecureField(tr("密码"), text: $password).textContentType(registering ? .newPassword : .password)
                if registering {
                    SecureField(tr("确认密码"), text: $confirmation).textContentType(.newPassword)
                    Text(tr("用户名为 3–32 位字母、数字、下划线、点或短横线；密码至少 6 位。")).font(.caption)
                    if !confirmation.isEmpty && confirmation != password { Text(tr("两次输入的密码不一致")).font(.caption).foregroundStyle(.orange) }
                }
                Button(model.busy ? tr("请稍候…") : registering ? tr("注册并登录") : tr("登录")) {
                    Task {
                        await model.login(cleanUsername, password, registering: registering, displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines))
                        password = ""; confirmation = ""
                    }
                }.disabled(!valid || model.busy)
            }.disabled(model.busy)
            Section {
                Button(registering ? tr("已有账号？返回登录") : tr("还没有账号？注册")) { registering.toggle(); password = ""; confirmation = ""; model.notice = nil }.disabled(model.busy)
                Text(tr("登录状态安全保存在此设备，退出登录后清除。")).font(.caption).foregroundStyle(.secondary)
            }
        }.navigationTitle(registering ? tr("注册") : tr("登录")).navigationBarTitleDisplayMode(.inline)
    }
}
