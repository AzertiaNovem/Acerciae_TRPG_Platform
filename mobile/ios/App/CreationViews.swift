import SwiftUI
import AcerciaeCore

struct CreateChannelView: View {
    @ObservedObject var model: AppModel
    let serverId: String
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var mode = "isolated"
    @State private var createdId: String?
    var body: some View {
        Form {
            TextField(tr("频道名称"), text: $name)
            TextField(tr("频道介绍"), text: $description, axis: .vertical)
            Picker(tr("角色知识"), selection: $mode) {
                Text(tr("隔离：只使用各自掌握的线索")).tag("isolated")
                Text(tr("公开：共享知识")).tag("public")
            }
            Text(tr("创建后你将成为此频道的守密人，并自动建立主聊天窗口。")).font(.caption)
        }.navigationTitle(tr("添加频道")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(tr("取消")) { dismiss() }.disabled(model.busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(createdId == nil ? tr("创建") : tr("打开频道")) { Task { await model.run {
                        if createdId == nil {
                            let value = try await model.get(["servers", serverId, "channels"], body: .object([
                                "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                                "description": .string(description), "knowledge_mode": .string(mode), "rule_system": .string("coc7e")]))
                            createdId = value["id"].text
                        }
                        guard model.serverId == serverId, let id = createdId else { dismiss(); return }
                        model.channels = try await model.typed(["servers", serverId, "channels"])
                        try await model.selectChannel(id); dismiss()
                    } } }.disabled(model.busy || !model.canCreateChannel || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
    }
}

struct CreateCharacterView: View {
    @ObservedObject var model: AppModel
    let channelId: String
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var style = ""
    @State private var kind = "pc"
    @State private var owner = ""
    @State private var members: [Resource] = []
    @State private var created: Resource?
    var body: some View {
        Group {
            if let created {
                CharacterSpace(model: model, character: created)
            } else {
                Form {
                    TextField(tr("角色姓名"), text: $name)
                    TextField(tr("说话风格"), text: $style, axis: .vertical)
                    if model.gm {
                        Picker(tr("类型"), selection: $kind) { Text(tr("玩家角色")).tag("pc"); Text("NPC").tag("npc") }
                        if kind == "pc" {
                            Picker(tr("所属玩家"), selection: $owner) {
                                Text(tr("我自己")).tag("")
                                ForEach(members.filter { $0.id != model.session?.user.id }) { member in Text(member["display_name"].text).tag(member.id) }
                            }
                        }
                    }
                    Text(tr("创建后可继续编辑属性、技能、背景和外观。")).font(.caption)
                    Button(tr("创建并编辑角色卡")) { Task { await model.run {
                        var body: [String: JSONValue] = ["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "kind": .string(kind), "speaking_style": .string(style)]
                        if model.gm && kind == "pc" && !owner.isEmpty { body["user_id"] = .string(owner) }
                        let value = try await model.get(["channels", channelId, "characters"], body: .object(body))
                        let character = try JSONDecoder().decode(Resource.self, from: JSONEncoder().encode(value))
                        // Creation succeeded: do not allow a failed refresh to submit it twice.
                        created = character
                        if model.channelId == channelId {
                            model.characters.append(character)
                            try await model.refresh()
                        }
                    } } }.disabled(model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }.navigationTitle(created == nil ? tr("添加角色") : tr("角色空间")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(tr("完成")) { dismiss() }.disabled(model.busy) } }
            .task { if model.gm { do { members = try await model.typed(["channels", channelId, "members"]) } catch { model.handle(error) } } }
    }
}
