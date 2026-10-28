import Foundation

public enum InterfaceLanguage {
    public static let codes = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "ru", "pt", "it"]
    public static let names = ["English", "简体中文", "繁體中文", "日本語", "한국어", "Español", "Français", "Deutsch", "Русский", "Português", "Italiano"]
    public static func supported(_ value: String) -> String {
        if codes.contains(value) { return value }
        if value.hasPrefix("zh") { return value.contains("Hant") || value.contains("TW") || value.contains("HK") ? "zh-TW" : "zh-CN" }
        let prefix = String(value.prefix(2)); return codes.contains(prefix) ? prefix : "en"
    }
}
public struct TranslationCatalog: Decodable {
    public let catalog: [String: [String]]
    public let aliases: [String: String]
    public func text(_ source: String, language: String) -> String {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = aliases[trimmed] ?? aliases[source] ?? trimmed
        let code = InterfaceLanguage.supported(language)
        if code == "zh-CN", aliases[source] != nil { return source }
        let index = (InterfaceLanguage.codes.firstIndex(of: code) ?? 0) - 1
        let translated = index >= 0 ? catalog[key]?.dropFirst(index).first ?? key : key
        guard aliases[source] != nil || aliases[trimmed] != nil || catalog[key] != nil else { return source }
        return source.replacingOccurrences(of: trimmed, with: translated)
    }
}
