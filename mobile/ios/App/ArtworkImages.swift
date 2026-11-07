import UIKit
import ImageIO
import AcerciaeCore

@MainActor enum ArtworkImages {
    private static let memory: NSCache<NSString, UIImage> = { let value = NSCache<NSString, UIImage>(); value.totalCostLimit = 32 * 1024 * 1024; return value }()
    private static var revision = 0
    private static var removed: [String: Int] = [:]
    static func cached(_ key: String) -> UIImage? { memory.object(forKey: key as NSString) }
    static func clear() { revision += 1; removed = [:]; memory.removeAllObjects() }
    static func remove(_ key: String) { removed[key, default: 0] += 1; memory.removeObject(forKey: key as NSString) }
    static func load(_ key: String, bytes: () async throws -> Data) async throws -> UIImage? {
        if let kept = cached(key) { return kept }
        let generation = revision
        let keyGeneration = removed[key, default: 0]
        let data = try await bytes()
        let image = await Task.detached(priority: .userInitiated) { () -> UIImage? in
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1920, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
            return UIImage(cgImage: image)
        }.value
        try Task.checkCancellation()
        guard generation == revision, keyGeneration == removed[key, default: 0] else { return nil }
        if let image { memory.setObject(image, forKey: key as NSString, cost: image.cgImage.map { $0.bytesPerRow * $0.height } ?? data.count) }
        return image
    }
}
