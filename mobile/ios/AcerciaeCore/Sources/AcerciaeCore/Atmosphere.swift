import Foundation

public enum Atmosphere {
    public static let variants = ["day_landscape", "night_landscape", "day_portrait", "night_portrait"]
    public static func variant(dark: Bool, portrait: Bool) -> String { (dark ? "night" : "day") + (portrait ? "_portrait" : "_landscape") }
    public static func asset(_ current: JSONValue, dark: Bool, portrait: Bool) -> String? {
        guard current["enabled"].bool, variants.allSatisfy({ !current["assets"][$0].text.isEmpty }) else { return nil }
        return current["assets"][variant(dark: dark, portrait: portrait)].text
    }
}
