import Foundation

public enum ChatIllustrations {
    /// The line, rather than the asset library, grants permission to see a picture.
    public static func path(channel: String, message: String) -> [String] {
        ["channels", channel, "messages", message, "image"]
    }
    public static func key(server: String, account: String, channel: String, message: String) -> String {
        ["chat-image", server, account, channel, message].joined(separator: "|")
    }
    public static func caption(_ content: String) -> String {
        var scalars = content.unicodeScalars
        guard scalars.first?.value == 0x1f5bc else { return content }
        scalars.removeFirst()
        if scalars.first?.value == 0xfe0f { scalars.removeFirst() }
        return String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    /// A message's picture never changes. Its endpoint explicitly allows private caching without `immutable`.
    /// Keep this exception confined to that route; an explicit no-store/no-cache still forbids persistence.
    public static func keepable(_ cacheControl: String?, path: [String]) -> Bool {
        let parts = (cacheControl ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        guard !parts.contains("no-store"), !parts.contains("no-cache") else { return false }
        if AssetDiskCache.keepable(cacheControl) { return true }
        guard path.count == 5, path[0] == "channels", path[2] == "messages", path[4] == "image" else { return false }
        return parts.contains { part in
            let pair = part.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            return pair.count == 2 && pair[0] == "max-age" && (Int(pair[1]) ?? 0) > 0
        }
    }
}
