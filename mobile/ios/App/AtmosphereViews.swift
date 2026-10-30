import SwiftUI
import ImageIO
import AcerciaeCore

struct AtmosphereBackdrop: View {
    @ObservedObject var model: AppModel
    @Environment(\.colorScheme) private var theme
    var body: some View {
        GeometryReader { geometry in
            if model.online && !model.channelId.isEmpty && model.session?.user.atmosphereEnabled == true && model.serverSettings["features"]["atmosphere"].bool {
                let variant = Atmosphere.variant(dark: theme == .dark, portrait: geometry.size.height >= geometry.size.width)
                ChannelBackdrop(model: model, dark: theme == .dark, portrait: geometry.size.height >= geometry.size.width)
                    .id((model.session?.user.id ?? "") + model.scopeKey + variant)
            }
        }.ignoresSafeArea(.keyboard).allowsHitTesting(false).accessibilityHidden(true)
    }
}
private struct ChannelBackdrop: View {
    @ObservedObject var model: AppModel
    let dark: Bool
    let portrait: Bool
    @Environment(\.scenePhase) private var phase
    @State private var image: UIImage?
    @State private var loadedAsset = ""
    @State private var mock = false
    var body: some View {
        GeometryReader { geometry in
            if let image {
                Image(uiImage: image).resizable().scaledToFill().frame(width: geometry.size.width, height: geometry.size.height).clipped().opacity(0.26)
                if mock { Text(tr("Mock background")).font(.caption2).padding(6).background(.ultraThinMaterial, in: Capsule()).padding(.horizontal, 24).padding(.bottom, 24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing) }
            }
        }.task(id: phase) {
            guard phase == .active else { return }
            while !Task.isCancelled {
                await load()
                do { try await Task.sleep(for: .seconds(30)) } catch { break }
            }
        }.onDisappear { image = nil; loadedAsset = "" }
    }
    @MainActor private func load() async {
        let channel = model.channelId
        do {
            let current = try await model.get(["channels", channel, "atmosphere"])
            try Task.checkCancellation()
            guard let id = Atmosphere.asset(current, dark: dark, portrait: portrait) else { image = nil; loadedAsset = ""; return }
            if id != loadedAsset {
                // Preview assets are candidates; use their dedicated authorized endpoint, never /media or a provider URL.
                let data = try await model.bytes(["channels", channel, "atmosphere", "assets", id])
                try Task.checkCancellation()
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1920, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { image = nil; loadedAsset = ""; return }
                image = UIImage(cgImage: decoded); loadedAsset = id
            }
            mock = current["mock"].bool
        } catch is CancellationError { return }
        catch { if !Task.isCancelled { image = nil; loadedAsset = "" } }
    }
}
struct AtmosphereHistory: View {
    @ObservedObject var model: AppModel
    @State private var history: [Resource] = []
    @State private var error = ""
    @State private var loading = false
    var body: some View {
        List {
            if model.gm {
                if loading { ProgressView() }
                if !error.isEmpty { Text(error).foregroundStyle(.orange) }
                Button(tr("Refresh")) { Task { await load() } }.disabled(loading)
                ForEach(history) { item in
                    DisclosureGroup(item["scene_label"].text + " · " + item["created_at"].text) {
                        Text(item["reason"].text).textSelection(.enabled)
                        if !item["mood"].text.isEmpty { Text(item["mood"].text) }
                        ForEach(Atmosphere.variants, id: \.self) { variant in
                            let job = item["variants"].array.first { $0["variant"].text == variant } ?? .null
                            Text(tr(atmosphereLabel(variant)) + " · " + tr(job["status"].string ?? "pending")).font(.headline)
                            Text(item["prompts"][variant].text).textSelection(.enabled)
                            if !job["error"].text.isEmpty { Text(job["error"].text).foregroundStyle(.orange) }
                        }
                    }
                }
            } else { Text(tr("仅当前频道的 GM 可访问")) }
        }.navigationTitle(tr("Atmosphere background history")).navigationBarTitleDisplayMode(.inline)
            .task(id: model.scopeKey) { await load() }.refreshable { await load() }
    }
    @MainActor private func load() async {
        guard model.gm else { history = []; return }
        guard !loading else { return }; loading = true; defer { loading = false }; error = ""
        do { let rows: [Resource] = try await model.typed(["channels", model.channelId, "atmosphere", "history"]); try Task.checkCancellation(); history = rows }
        catch { if !Task.isCancelled { history = []; self.error = error.localizedDescription } }
    }
}
func atmosphereLabel(_ variant: String) -> String {
    ["day_landscape": "Landscape · light theme", "night_landscape": "Landscape · dark theme", "day_portrait": "Portrait · light theme", "night_portrait": "Portrait · dark theme"][variant] ?? variant
}
