import SwiftUI
import ImageIO
import AcerciaeCore

// Decoded, small thumbnails only; keys include account, channel permissions and asset revision.
@MainActor private enum AvatarCache {
    static let images: NSCache<NSString, UIImage> = { let cache = NSCache<NSString, UIImage>(); cache.countLimit = 128; return cache }()
}
struct AvatarView: View {
    @ObservedObject var model: AppModel
    let name: String
    var assetId = ""
    var version = ""
    var ownerId = ""
    var ownerVersion = 0
    var size: CGFloat = 32
    @State private var image: UIImage?
    private var ownData: String { ownerId == model.session?.user.id ? model.session?.user.avatarData ?? "" : "" }
    private var key: String { (model.session?.user.id ?? "") + model.scopeKey + assetId + version + ownerId + String(ownerVersion) + String(model.session?.user.avatarVersion ?? 0) }
    var body: some View {
        ZStack {
            Circle().fill(Color(red: 0.28, green: 0.32, blue: 0.29))
            if let image { Image(uiImage: image).resizable().scaledToFill() }
            else { Text(String(name.prefix(1))).font(.caption.weight(.medium)) }
        }.frame(width: size, height: size).clipShape(Circle()).accessibilityHidden(true)
        .task(id: key) {
            image = nil
            if let cached = AvatarCache.images.object(forKey: key as NSString) { image = cached; return }
            let requestKey = key
            var bytes: Data?
            if !assetId.isEmpty {
                bytes = try? await model.bytes(["channels", model.channelId, "media", assetId], query: Int(version).map { $0 > 0 ? ["v": String($0)] : [:] } ?? [:])
            } else if ownData.hasPrefix("data:image/"), let comma = ownData.firstIndex(of: ",") {
                bytes = Data(base64Encoded: String(ownData[ownData.index(after: comma)...]))
            } else if !ownerId.isEmpty && ownerVersion > 0 {
                bytes = try? await model.bytes(["users", ownerId, "avatar"], query: ["v": String(ownerVersion)])
            }
            guard !Task.isCancelled, requestKey == key, let bytes,
                  let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 216, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return }
            let decoded = UIImage(cgImage: thumbnail)
            AvatarCache.images.setObject(decoded, forKey: requestKey as NSString); image = decoded
        }
    }
}
