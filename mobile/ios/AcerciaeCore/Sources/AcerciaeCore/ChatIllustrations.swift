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
    /// The name a saved copy gets, as the server names a download but without its date (a line here carries none):
    /// "illustration-<description>.png" (the line's text without its mark, at most 40 characters, any script kept,
    /// characters file systems refuse replaced by "-"); the extension follows the picture's bytes.
    public static func fileName(_ content: String, data: Data) -> String {
        let refused = Set(" \t/\\:*?\"<>|.,;!'`#%&{}[]()=+~$@^".unicodeScalars)
        var slug = ""
        var count = 0
        for scalar in caption(content).unicodeScalars {
            if count >= 40 { break }
            count += 1
            if scalar.value < 0x20 || scalar.value == 0x7f || refused.contains(scalar) || CharacterSet.whitespacesAndNewlines.contains(scalar) {
                if !slug.isEmpty && !slug.hasSuffix("-") { slug += "-" }
            } else {
                slug.unicodeScalars.append(scalar)
            }
        }
        while slug.hasSuffix("-") { slug.removeLast() }
        while slug.hasPrefix("-") { slug.removeFirst() }
        return "illustration" + (slug.isEmpty ? "" : "-" + slug) + fileExtension(data)
    }
    public static func fileExtension(_ data: Data) -> String {
        let head = [UInt8](data.prefix(12))
        if head.count >= 3, head[0] == 0xFF, head[1] == 0xD8, head[2] == 0xFF { return ".jpg" }
        if head.count >= 12, Array(head[0..<4]) == [0x52, 0x49, 0x46, 0x46], Array(head[8..<12]) == [0x57, 0x45, 0x42, 0x50] { return ".webp" }
        if head.count >= 4, Array(head[0..<4]) == [0x47, 0x49, 0x46, 0x38] { return ".gif" }   // a member's uploaded picture may be one
        return ".png"
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
