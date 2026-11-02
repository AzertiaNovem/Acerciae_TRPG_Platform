import SwiftUI
import AcerciaeCore
struct ChatNotice: Identifiable {
    let id: String
    let title: String
    let messages: [Message]
}
struct ChatActivityBanners: View {
    @ObservedObject var model: AppModel
    let open: () -> Void
    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(model.chatNotices.prefix(4)) { notice in ChatNoticeCard(model: model, notice: notice, open: open) }
        }.frame(maxWidth: 320).padding(12).frame(maxWidth:.infinity, alignment:.trailing)
    }
}
private struct ChatNoticeCard: View {
    @ObservedObject var model: AppModel
    let notice: ChatNotice
    let open: () -> Void
    @State private var expanded = false
    var body: some View {
        VStack(alignment:.leading, spacing:6) {
            HStack {
                Button(notice.title + (notice.messages.count > 1 ? " · \(notice.messages.count)" : "")) { expanded.toggle() }.font(.subheadline.weight(.semibold))
                Spacer(); Button { model.dismissNotice(notice.id) } label: { Image(systemName:"xmark") }.accessibilityLabel(tr("Close"))
            }
            ForEach(Array(notice.messages.prefix(expanded ? 6 : 1))) { m in
                Button { Task { await model.run { try await model.openEvidence(.object(["message_id":.string(m.id),"chat_window_id":.string(notice.id)]), quote:false); model.dismissNotice(notice.id); open() } } } label: {
                    HStack(alignment:.top) {
                        AvatarView(model:model,name:WindowActivity.speaker(m),assetId:m.kind == "ooc" ? "" : m.characterAvatarAssetId ?? "",version:String(m.characterAvatarVersion ?? 0),ownerId:m.authorId ?? "",ownerVersion:m.authorAvatarVersion ?? 0)
                        VStack(alignment:.leading) { Text(WindowActivity.speaker(m)).font(.caption.weight(.semibold)); Text(m.displayText).font(.caption).lineLimit(2) }.frame(maxWidth:.infinity,alignment:.leading)
                    }
                }.buttonStyle(.plain)
            }
        }.padding(12).background(.regularMaterial,in:RoundedRectangle(cornerRadius:18))
        .task(id:"\(notice.messages.first?.id ?? "")-\(expanded)") { guard !expanded else { return }; do { try await Task.sleep(for:.seconds(6)); model.dismissNotice(notice.id) } catch {} }
    }
}
struct InitiativeView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        DisclosureGroup(tr("Initiative") + " · " + tr("Round") + " \(model.initiative["round"].int)") {
            ForEach(Array(model.initiative["entries"].array.enumerated()),id:\.offset) { index,e in
                HStack {
                    Text((model.initiative["turn"].text == e["id"].text ? "› " : "") + e["name"].text)
                    Spacer(); Text(String(e["total"].int))
                    if model.gm || e["created_by"].text == model.session?.user.id {
                        Button(tr("Remove")) { Task { await model.initiativeAction("remove",entry:e["id"].text) } }
                    }
                }.font(.caption)
            }
            if model.gm {
                HStack {
                    Button(tr("Next turn")) { Task { await model.initiativeAction("next") } }
                    Button(tr("Clear")) { Task { await model.initiativeAction("clear") } }
                }
            }
        }.padding(12).background(.thinMaterial,in:RoundedRectangle(cornerRadius:14))
    }
}
