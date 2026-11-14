import SwiftUI
import UIKit
import AcerciaeCore

// The app's theme, shared with the interactive message cards (HypertextCardView.swift).
let ink = Color(red: 0.07, green: 0.086, blue: 0.098)
let panelColor = Color(red: 0.14, green: 0.165, blue: 0.18)
let accent = Color(red: 0.79, green: 0.85, blue: 0.74)

struct RootView: View {
    @StateObject private var model: AppModel
    init(onAccountChanged: @escaping () -> Void = {}) {
        _model = StateObject(wrappedValue: AppModel(onAccountChanged: onAccountChanged))
    }
    @ObservedObject private var locale = MobileLocale.shared
    @State private var studioOpen = false
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
                .overlay(alignment:.topTrailing) {
                    if reveal == 0 && !model.chatNotices.isEmpty { ChatActivityBanners(model:model) { page = "chat"; detail = nil }.padding(.top,64) }
                }

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
                        if destination == "openstudio" { studioOpen = true } else { page = destination }; closeSidebar()
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
        .task(id:"\(page)-\(sidebarOpen)-\(detail != nil)-\(scenePhase)-\(studioOpen)") { model.chatVisible = page == "chat" && !studioOpen && !sidebarOpen && detail == nil && scenePhase == .active; if !model.chatVisible { model.speech.stopSpeaking(at:.immediate) } }
        .onChange(of: model.online) { _, _ in page = "chat"; sidebarOpen = false; dragOffset = 0; detail = nil }
        .task(id: "\(model.session?.user.id ?? "")-\(scenePhase)") {
            model.foreground = scenePhase == .active
            if scenePhase != .active { model.speech.stopSpeaking(at:.immediate); model.chatNotices = [] }
            guard model.online, scenePhase == .active else { return }
            model.followRealtime()
            await model.poll(forceCatalog: true)
            while !Task.isCancelled {
                // A push (or a reconnect) wakes the loop within a quarter second; while the chat stream is live the
                // timed poll is only a safety net. The stream follows whichever channel is on screen.
                var waited = 0.0
                repeat {
                    do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
                    waited += 0.25; model.followRealtime()
                } while !model.pushPending && waited < (model.pushConnected ? 30 : 4)
                await model.poll()
            }
        }
        .fullScreenCover(isPresented:$studioOpen) { LocalStudioView() }
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
    @State private var serversExpanded = true
    @State private var channelsExpanded = true
    @State private var windowsExpanded = true
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
                        AccountMenu(model: model)
                        DisclosureGroup(tr("Servers"), isExpanded: $serversExpanded) {
                            ForEach(model.servers) { server in
                                row(server.name, icon: "server.rack", selected: model.serverId == server.id) { model.navigate { try await model.selectServer(server.id) } }
                            }
                            row(tr("Servers"), icon: "globe") { browsingServers = true }
                        }
                        if model.serverSettings["is_maintainer"].bool { row(tr("服务器选项"), icon: "server.rack") { select("server") } }
                        HStack {
                            Button { channelsExpanded.toggle() } label: {
                                HStack { Image(systemName: channelsExpanded ? "chevron.down" : "chevron.right"); Text(tr("频道")) }.frame(maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(.plain).accessibilityValue(tr(channelsExpanded ? "Expanded" : "Collapsed"))
                            Spacer()
                            Button { creatingChannel = true } label: { Image(systemName: "plus") }.accessibilityLabel(tr("添加频道")).disabled(model.serverId.isEmpty || !model.canCreateChannel)
                        }
                        if channelsExpanded { ForEach(model.channels) { item in
                            row(item.name, icon: "number", selected: model.channelId == item.id) { model.navigate { try await model.selectChannel(item.id) } }
                        } }
                        if model.gm { row(tr("频道选项"), icon: "slider.horizontal.3") { select("channel") } }
                        DisclosureGroup(tr("聊天窗口"), isExpanded: $windowsExpanded) {
                        ForEach(model.windows) { item in
                            row(item.name + (item["unread"].int > 0 ? " · " + (item["unread"].int > 99 ? "99+" : String(item["unread"].int)) : ""), icon: "bubble.left", selected: model.windowId == item.id) { select("chat"); model.navigate { try await model.selectWindow(item.id) } }
                        }
                        }
                        DisclosureGroup(tr("角色"), isExpanded: $charactersExpanded) {
                            if !model.channelId.isEmpty { row(tr("添加角色"), icon: "person.badge.plus") { creatingCharacter = true } }
                            ForEach(model.characters) { item in
                                Button { model.result = nil; selectedCharacter = item } label: {
                                    HStack(spacing: 10) {
                                        AvatarView(model: model, name: item.name, assetId: item["avatar_asset_id"].text, version: item["avatar_asset_version"].int, hash: item["avatar_asset_hash"].text)
                                        CharacterStatusLines(item: item, typing: model.typing[item.id] != nil)
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
                            row("GM", icon: "person.crop.circle") {
                                showDetail(SidebarDetail(title: "GM", body: "频道 GM\n负责场景叙述与裁定；频道 GM 身份不等于服务器管理员。"))
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
                row(tr("Open Log Studio"), icon: "books.vertical", selected:false) { select("openstudio") }
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

/// A character's entry in the sidebar besides the avatar: the name, a pen while the character is being written as, and
/// on a second line the numbers that matter at the table (AcerciaeCore/TableStatus.swift), hit points in red at a
/// third or less.
private struct CharacterStatusLines: View {
    let item: Resource
    let typing: Bool
    var body: some View {
        let parts = Vitals.of(item)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(item.name).lineLimit(1)
                if !(item["passive_since"].string ?? "").isEmpty { Text(tr("passive")).font(.caption2).accessibilityLabel(tr("Player away: passively present")) }
                if typing { Text("✎").foregroundStyle(.yellow).accessibilityLabel(tr("typing…")) }
            }
            if !parts.isEmpty { vitals(parts).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func vitals(_ parts: [VitalPart]) -> Text {
        var line = Text("")
        for (index, part) in parts.enumerated() {
            if index > 0 { line = line + Text(" · ") }
            if part.low { line = line + Text(part.text).foregroundColor(.red) } else { line = line + Text(part.text) }
        }
        return line
    }
}

private struct ChatView: View {
    @ObservedObject var model: AppModel
    @State private var hintsOpen = false
    var body: some View {
        Group {
            if let campaign = model.campaign {
                ScrollViewReader { proxy in
                    VStack(spacing:0) {
                    if model.channel["rule_system"].text == "dnd2024" { InitiativeView(model:model) }
                    ScrollView {
                        LazyVStack(spacing: 20) {
                            Text(campaign.scene).font(.caption).foregroundStyle(accent)
                            if model.online && model.hasOlder { Button(tr("加载更早消息")) { Task { await model.older() } }.disabled(model.busy) }
                            ForEach(campaign.messages) { MessageBubble(message: $0, model: model).id($0.id) }
                        }.padding(16)
                    }
                    .onChange(of: model.jumpMessageId) { _, id in if let id { withAnimation { proxy.scrollTo(id, anchor: .center) } } }
                    .onAppear { if let id = campaign.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
                    .refreshable { await model.poll() }
                    .scrollDismissesKeyboard(.interactively)
                    .chatScrollEdge()
                    .mask {
                        VStack(spacing: 0) {
                            LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: 28)
                            Color.black
                        }
                    }
                    .onChange(of: campaign.messages.last?.id) { _, _ in
                        if let id = campaign.messages.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                    }
                }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        if !model.typingLine.isEmpty {
                            Text(model.typingLine).font(.caption2).foregroundStyle(.secondary).lineLimit(1).padding(.horizontal, 26)
                        }
                        Composer(model: model)
                    }
                }
                .navigationTitle(model.online ? model.windowName : campaign.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(.hidden, for: .navigationBar)
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button(tr("提示") + " \(model.reminders.count + (model.gm ? campaign.documents.count + 2 : 0))") { hintsOpen.toggle(); model.result = nil }
                        Button("✦ " + tr("灵感")) { hintsOpen = false; Task { await model.assistance("inspiration") } }.disabled(model.busy || !model.enabled("inspiration") || model.windowId.isEmpty)
                    }
                }
                .overlay(alignment: .topTrailing) {
                    GeometryReader { geometry in
                        if hintsOpen || model.result != nil {
                            VStack {
                                if hintsOpen { HintOverlay(model: model, close: { hintsOpen = false }).id(model.scopeKey + model.windowId) }
                                else { AssistanceOverlay(model: model) }
                            }
                            .frame(width: min(420, max(0, geometry.size.width - 24)), height: max(0, geometry.size.height * 0.67))
                            .background(panelColor, in: RoundedRectangle(cornerRadius: 22))
                            .overlay(RoundedRectangle(cornerRadius: 22).stroke(.white.opacity(0.15)))
                            .shadow(color: .black.opacity(0.3), radius: 14, y: 6)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(12)
                        }
                    }
                }
                .onChange(of: model.scopeKey) { _, _ in hintsOpen = false }
                .onChange(of: model.windowId) { _, _ in hintsOpen = false }
                .onChange(of: model.result) { _, value in if value != nil { hintsOpen = false } }

            } else { ContentUnavailableView(model.servers.isEmpty ? tr("尚未加入服务器") : tr("从侧栏选择频道和聊天窗口"), systemImage: "bubble.left", description: Text(model.servers.isEmpty ? tr("Ask a server administrator to invite your account: {username}").replacingOccurrences(of: "{username}", with: model.session?.user.username ?? "") : tr("选择一个频道开始聊天"))) }
        }
        .background {
            ZStack {
                ink
                AtmosphereBackdrop(model: model)
                VStack { LinearGradient(colors: [ink.opacity(0.9), ink.opacity(0.4), .clear], startPoint: .top, endPoint: .bottom).frame(height: 190); Spacer(minLength: 0) }.allowsHitTesting(false)
            }.ignoresSafeArea()
        }
    }
}

private extension View {
    @ViewBuilder func chatScrollEdge() -> some View {
        // Xcode 16 has no declaration for this iOS 26 modifier, even behind a runtime availability check.
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) { self.scrollEdgeEffectHidden(true, for: .top) } else { self }
        #else
        self
        #endif
    }
}


private struct MessageBubble: View {
    let message: Message
    @ObservedObject var model: AppModel
    private var mine: Bool { message.authorId != nil && message.authorId == model.session?.user.id }
    // Out of character the player speaks: their own avatar and name.
    private var ooc: Bool { message.kind == "ooc" && message.standIn != true }
    private var name: String { (ooc ? nil : message.characterName) ?? message.authorName }
    // The line above the bubble: who speaks, how, and a pin while the line is pinned among the group's hints.
    private var header: String {
        var text = name
        if message.standIn == true { text += " · " + tr("stand-in") }
        if mine { text += " · " + tr("Me") }
        if message.kind == "narration" { text += " · " + tr("Narration") } else if message.kind == "ooc" { text += " · OOC" }
        if model.pinOf(message) != nil { text += " · 📌" }
        return text
    }
    var body: some View {
        if message.recalled {
            // Taken back by its author: one quiet line in its place; the author can edit the text again.
            HStack(spacing: 8) {
                Text(mine ? tr("You recalled a message") : tr("{name} recalled a message").replacingOccurrences(of: "{name}", with: name))
                    .font(.caption).italic().foregroundStyle(.secondary)
                if mine && model.recallDrafts[message.id] != nil { Button(tr("Re-edit")) { model.reedit(message.id) }.font(.caption) }
            }.frame(maxWidth: .infinity)
        } else if separate && message.diceTone == .notice {
            // A hidden roll's public notice is the dice's own announcement.
            DiceBotRow(message: message, model: model, provenance: true)
        } else if separate {
            VStack(spacing: 12) { bubble; DiceBotRow(message: message, model: model) }
        } else { bubble }
    }
    // Dice results follow the account's choice: a separate message from the dice (default) or under the command.
    private var separate: Bool { message.dice != nil && DiceDisplay.isSeparate(model.session?.user) }
    private var bubble: some View {
        HStack(alignment: .top, spacing: 8) {
            if mine { Spacer(minLength: 36) } else { avatar }
            VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(header).font(.caption).foregroundStyle(.secondary)
                    if message.isHypertext { HypertextPill() }
                }
                if message.viaHypertextId != nil { HypertextViaPill(answering: message.answering) }
                if message.dice != nil && (message.referenceIds ?? []).isEmpty && !separate { DiceResultView(message: message).modifier(MessageMenu(message: message, model: model)) } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(message.referenceIds ?? [], id: \.self) { id in
                            ChatReferenceView(messageId: id, model: model)
                                .id("\(model.session?.user.id ?? ""):\(model.scopeKey):\(model.windowId):\(id)")
                        }
                        if message.isHypertext { HypertextBody(message: message, model: model) }
                        else if message.dice != nil && separate { Text(message.content).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
                        else if message.dice != nil { DiceResultView(message: message) }
                        else if message.hasIllustration { ChatIllustration(message: message, model: model) }
                        else { Text(message.displayText).textSelection(.enabled) }
                    }
                    .padding(14)
                    .background(mine ? Color(red: 0.21, green: 0.26, blue: 0.22) : panelColor,
                        in: UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: mine ? 18 : 5,
                                                   bottomTrailingRadius: mine ? 5 : 18, topTrailingRadius: 18))
                    .modifier(MessageMenu(message: message, model: model))
                }
            }
            if mine { avatar } else { Spacer(minLength: 36) }
        }
    }
    private var avatar: some View {
        let character = ooc ? nil : model.characters.first(where: { $0.id == message.characterId })
        let picture = ooc ? nil : CharacterArtwork.avatar(character: character, message: message)
        return AvatarView(model: model, name: name, assetId: picture?.id ?? "", version: picture?.version ?? 0, ownerId: message.authorId ?? "", ownerVersion: message.authorAvatarVersion ?? 0, hash: picture?.hash ?? "", ownerHash: message.authorAvatarHash ?? "")
    }
}

/// A long press on a line offers "Copy" (the menu takes over from text selection), "Pin" to keep it among the group's
/// hints or "Unpin" for its pinner and the GM, and on one of the user's own lines, while it can still be recalled,
/// "Recall". A line with none of these keeps plain text selection.
private struct MessageMenu: ViewModifier {
    let message: Message
    @ObservedObject var model: AppModel
    func body(content: Content) -> some View {
        let pin = model.pinOf(message)
        let offersPin = model.online && pin == nil && Pins.canPin(message)
        let offersUnpin = pin.map { Pins.canUnpin($0, userId: model.session?.user.id, gm: model.gm) } ?? false
        let offersRecall = model.canRecall(message)
        if offersPin || offersUnpin || offersRecall {
            content.contextMenu {
                Button { UIPasteboard.general.string = message.displayText } label: { Label(tr("Copy"), systemImage: "doc.on.doc") }
                if offersPin { Button { Task { await model.pin(message) } } label: { Label(tr("Pin"), systemImage: "pin") } }
                if offersUnpin, let pin { Button { Task { await model.unpin(pin.id) } } label: { Label(tr("Unpin"), systemImage: "pin.slash") } }
                if offersRecall { Button(role: .destructive) { Task { await model.recall(message) } } label: { Label(tr("Recall"), systemImage: "arrow.uturn.backward") } }
            }
        } else { content }
    }
}

private struct ChatReferenceView: View {
    let messageId: String
    @ObservedObject var model: AppModel
    @State private var original: Message?
    @State private var unavailable = false
    private var message: Message? {
        unavailable ? nil : original ?? model.campaign?.messages.first { $0.id == messageId }
    }
    private var recalled: Bool { model.recalledMessages[messageId] != nil || model.campaign?.messages.first { $0.id == messageId }?.recalled == true }
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if recalled {
                Text(tr("This message was recalled.")).font(.caption).foregroundStyle(.secondary)
            } else if let message {
                Text((message.kind == "ooc" ? nil : message.characterName) ?? message.authorName)
                    .font(.caption2).lineLimit(1)
                Text(message.displayText).font(.caption).lineLimit(2).textSelection(.enabled)
            } else {
                Text(tr(unavailable ? "Reference unavailable for your current view." : "Loading…"))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 8)
        .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 1).fill(accent.opacity(0.5)).frame(width: 2) }
        .task {
            let scope = model.scopeKey; let user = model.session?.user.id
            do {
                let value: Message = try await model.typed(["channels", model.channelId, "messages", messageId])
                guard !Task.isCancelled, scope == model.scopeKey, user == model.session?.user.id else { return }
                original = value; unavailable = false
            } catch {
                guard !Task.isCancelled, scope == model.scopeKey, user == model.session?.user.id else { return }
                let denied = [401, 403, 404].contains((error as? ClientError)?.httpStatus ?? 0)
                if denied { original = nil }
                unavailable = denied || message == nil
            }
        }
    }
}

private struct Composer: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(model.references) { message in
                HStack { Text(message.content).font(.caption).lineLimit(2); Spacer(); Button { model.references.removeAll { $0.id == message.id } } label: { Image(systemName: "xmark") }.accessibilityLabel(tr("Remove reference")) }
            }
            TextField(tr("What does your character do or say?"), text: Binding(get: { model.draft }, set: { value in
                if value != model.draft { model.draft = value; model.noteTyping() }
            }), axis: .vertical)
                .lineLimit(1...5).padding(.horizontal, 6).padding(.top, 6)
            if !model.diceHint.isEmpty { Text(model.diceHint).font(.caption).foregroundStyle(.secondary) }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { modeMenu; roleMenu; assistance; Spacer(minLength: 0); sendButton }
                VStack(spacing: 10) {
                    HStack { modeMenu; roleMenu; Spacer(); sendButton }
                    HStack { assistance; Spacer() }
                }
            }
        }
        .task(id: "\(model.draft)-\(model.characterId)") {
            do { try await Task.sleep(for: .milliseconds(400)); await model.previewDice() } catch {}
        }
        .padding(14).background(panelColor, in: RoundedRectangle(cornerRadius: 26))
        .padding(.horizontal, 12).padding(.vertical, 8)
    }
    private var modeMenu: some View {
        Menu {
            Picker(tr("Message kind"), selection: $model.speechMode) {
                Text(tr("Narration")).tag("narration")
                Text(tr("In character")).tag("ic")
                Text(tr("Out of character")).tag("ooc")
            }
        } label: { Label(tr(model.speechMode == "narration" ? "Narration" : model.speechMode == "ic" ? "In character" : "Out of character"), systemImage: "chevron.down").font(.subheadline) }
    }
    private var roleMenu: some View {
        Menu {
            ForEach(model.playable) { item in Button(item.name) { model.chooseRole(item.id) } }
            Button(model.gm ? tr("— as GM —") : model.session?.user.displayName ?? tr("Me")) { model.chooseRole("") }
        } label: { Text(model.characterId.isEmpty ? (model.gm ? "GM" : tr("Me")) : model.role).font(.subheadline).lineLimit(1) }
    }
    private var assistance: some View {
        Button("⚖ " + tr("一致性")) { Task { await model.assistance("consistency") } }.disabled(model.busy || !model.enabled("consistency") || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).font(.subheadline).frame(minHeight: 44)
    }
    private var sendButton: some View {
        Button(action: model.sendDemo) { Image(systemName: "arrow.up").font(.body.bold()).frame(width: 44, height: 44) }
            .background(accent, in: Circle()).foregroundStyle(ink)
            .disabled(model.busy || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .opacity(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
            .accessibilityLabel(tr("发送"))
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
                    HStack(spacing: 12) { AvatarView(model: model, name: user.displayName, ownerId: user.id, ownerVersion: user.avatarVersion ?? 0, size: 48, ownerHash: user.avatarHash ?? ""); Text(user.displayName) }
                    Text(user.username).foregroundStyle(.secondary)
                }
                AccountMenu(model: model)
                Button(tr("退出登录"), role: .destructive) { model.logout() }.disabled(model.busy)
            }
            Section { LanguagePicker(model: model); Text(tr("This changes your interface only. Server AI output language stays unchanged.")).font(.caption) }
            Section(tr("Dice results")) {
                Picker(tr("Dice results"), selection: Binding(get: { model.session?.user.diceDisplay ?? DiceDisplay.separate }, set: { value in Task { await model.changeDiceDisplay(value) } })) {
                    Text(tr("As a separate message from the dice")).tag(DiceDisplay.separate)
                    Text(tr("Under the roll command")).tag(DiceDisplay.inline)
                }.disabled(model.busy)
            }
            Section(tr("Channel atmosphere backgrounds")) {
                Toggle(tr("Show channel atmosphere backgrounds"), isOn: Binding(get: { model.session?.user.atmosphereEnabled == true }, set: { value in Task { await model.changeAtmosphere(value) } })).disabled(model.busy)
                Text(tr("Backgrounds follow the app theme and screen orientation. The server must also enable this feature.")).font(.caption)
            }
            Section(tr("Messages")) {
                Toggle(tr("Message banners"), isOn: Binding(get: { model.bannersEnabled },set: model.setBanners))
                Toggle(tr("Read aloud"), isOn: Binding(get: { model.readAloud },set: model.setReadAloud))
                Text(tr("Uses this phone’s speech voices. Only new messages in the visible chat are read.")).font(.caption)
                Button(tr("Stop reading")) { model.speech.stopSpeaking(at:.immediate) }
            }
            Section(tr("内容同步")) {
                Button(tr("立即刷新")) { Task { await model.poll(forceCatalog: true) } }.disabled(model.busy)
                Text(tr(model.connection)).foregroundStyle(accent)
                Text(tr("聊天每 4 秒刷新，服务器与频道列表每 30 秒同步，回到前台立即更新。")).font(.caption)
            }
        }.navigationTitle(tr("设置")).navigationBarTitleDisplayMode(.inline)
    }
}

private struct AuthenticationView: View {
    @State private var studioOpen = false
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
            if !model.accountUsers.isEmpty {
                Section(tr("Switch account")) {
                    ForEach(model.accountUsers, id: \.id) { user in
                        Button("\(user.displayName) · @\(user.username)") { model.selectAccount(user.id) }
                    }
                }.disabled(model.busy)
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
                Button(tr("Open Log Studio (offline, no account) →")) { studioOpen = true }
                Text(tr("登录状态安全保存在此设备，退出登录后清除。")).font(.caption).foregroundStyle(.secondary)
            }
        }.navigationTitle(registering ? tr("注册") : tr("登录")).navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(isPresented:$studioOpen) { LocalStudioView() }
    }
}

private struct AccountMenu: View {
    @ObservedObject var model: AppModel
    var body: some View {
        Menu {
            ForEach(model.accountUsers, id: \.id) { user in
                Button { model.selectAccount(user.id) } label: {
                    if user.id == model.session?.user.id {
                        Label("\(user.displayName) · @\(user.username)", systemImage: "checkmark")
                    } else { Text("\(user.displayName) · @\(user.username)") }
                }.disabled(user.id == model.session?.user.id)
            }
            Divider()
            Button(tr("Add account")) { model.selectAccount(nil) }
        } label: { Label(model.session?.user.displayName ?? tr("Switch account"), systemImage: "person.2") }
        .accessibilityLabel(tr("Switch account")).disabled(model.busy)
    }
}
