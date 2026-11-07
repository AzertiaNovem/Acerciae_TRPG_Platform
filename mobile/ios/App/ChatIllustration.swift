import SwiftUI
import AcerciaeCore

struct ChatIllustration: View {
    let message: Message
    @ObservedObject var model: AppModel
    @State private var image: UIImage?
    @State private var loadedKey = ""
    @State private var failed = false
    @State private var attempt = 0
    @State private var expanded = false

    private var channel: String { message.channelId ?? model.channelId }
    private var imageKey: String { ChatIllustrations.key(server: model.endpoint, account: model.session?.user.id ?? "", channel: channel, message: message.id) }
    private var unavailable: Bool { !message.hasIllustration || model.recalledMessages[message.id] != nil || model.session == nil || channel != model.channelId }
    private var requestKey: String { imageKey + "|" + model.scopeKey + "|" + String(unavailable) }
    private var visibleImage: UIImage? { !unavailable && loadedKey == requestKey ? image : nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let image = visibleImage {
                Button { expanded = true } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 360)
                        .fixedSize(horizontal: false, vertical: true)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }.buttonStyle(.plain).accessibilityLabel(tr("View illustration"))
            } else if !unavailable {
                if failed {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tr("The picture could not be loaded.")).font(.caption)
                        Button(tr("Retry")) { attempt += 1 }
                    }
                } else { ProgressView(tr("Loading…")).frame(maxWidth: .infinity, minHeight: 100) }
            }
            if !unavailable && !message.illustrationCaption.isEmpty {
                Text(message.illustrationCaption).textSelection(.enabled)
            }
        }
        .task(id: requestKey + "|" + String(attempt)) { await load() }
        .onChange(of: requestKey) { _, _ in expanded = false }
        .fullScreenCover(isPresented: $expanded) {
            if let image {
                IllustrationPreview(image: image, message: message, model: model, scope: model.scopeKey, account: model.session?.user.id ?? "")
            }
        }
    }
    private func load() async {
        let key = requestKey, memoryKey = imageKey
        expanded = false; loadedKey = key; image = nil; failed = false
        guard !unavailable else { return }
        if let cached = ArtworkImages.cached(memoryKey) { image = cached; return }
        do {
            let value = try await ArtworkImages.load(memoryKey) {
                try await model.bytes(ChatIllustrations.path(channel: channel, message: message.id))
            }
            try Task.checkCancellation()
            guard key == requestKey, !unavailable else { return }
            if value == nil { await model.discardMessageImage(channel: channel, message: message.id) }
            try Task.checkCancellation()
            guard key == requestKey, !unavailable else { return }
            image = value; failed = value == nil
        } catch {
            guard !Task.isCancelled, key == requestKey, !unavailable else { return }
            failed = true
        }
    }
}

private struct IllustrationPreview: View {
    let image: UIImage
    let message: Message
    @ObservedObject var model: AppModel
    let scope: String
    let account: String
    @Environment(\.dismiss) private var dismiss
    private var available: Bool { model.recalledMessages[message.id] == nil && model.scopeKey == scope && model.session?.user.id == account }
    var body: some View {
        Group {
            if available {
                VStack(spacing: 0) {
                    HStack { Spacer(); Button(tr("Close")) { dismiss() }.padding() }
                    ZoomableIllustration(image: image, caption: message.illustrationCaption)
                }
            }
        }.background(Color(uiColor: .systemBackground)).foregroundStyle(.primary)
            .onChange(of: available) { _, allowed in if !allowed { dismiss() } }
    }
}

private struct ZoomableIllustration: UIViewRepresentable {
    let image: UIImage
    let caption: String
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> IllustrationScrollView {
        let scroll = IllustrationScrollView()
        scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 6
        scroll.delegate = context.coordinator
        scroll.picture.contentMode = .scaleAspectFit
        scroll.picture.isAccessibilityElement = true
        scroll.addSubview(scroll.picture)
        return scroll
    }
    func updateUIView(_ scroll: IllustrationScrollView, context: Context) {
        scroll.picture.image = image
        scroll.picture.accessibilityLabel = caption.isEmpty ? tr("View illustration") : caption
    }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { (scrollView as? IllustrationScrollView)?.picture }
    }
}
private final class IllustrationScrollView: UIScrollView {
    let picture = UIImageView()
    override func layoutSubviews() {
        super.layoutSubviews()
        if zoomScale == 1 { picture.frame = bounds; contentSize = bounds.size }
    }
}
