import Foundation

public struct RuleNames {
    public let rules: JSONValue
    public let language: String
    public init(rules: JSONValue, language: String) { self.rules = rules; self.language = InterfaceLanguage.supported(language) }
    private var entries: [JSONValue] { rules["skills"].array + rules["families"].array + rules["characteristics"].array }
    private func local(_ item: JSONValue) -> String { item["names"][language].string ?? item["name"].text }
    public func skillLabel(_ key: String) -> String {
        if let item = entries.first(where: { $0["name"].text == key }) { return local(item) }
        let (family, spec) = Self.split(key)
        guard !spec.isEmpty, let item = entries.first(where: { $0["name"].text == family }) else { return key }
        return local(item) + (language.hasPrefix("zh") || language == "ja" ? "（\(spec)）" : language == "ko" ? "(\(spec))" : " (\(spec))")
    }
    public func skillKey(_ text: String) -> String {
        func find(_ value: String) -> JSONValue? { entries.first { Self.norm($0["name"].text) == Self.norm(value) || Self.norm(local($0)) == Self.norm(value) } }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return t }
        if let item = find(t) { let key = item["name"].text; return key == "Fighting" ? "Fighting (Brawl)" : key == "Firearms" ? "Firearms (Handgun)" : key }
        let (f, spec) = Self.split(t)
        guard !spec.isEmpty, let item = find(f) else { return t }
        let key = item["name"].text
        return (key == "Fighting (Brawl)" ? "Fighting" : key.hasPrefix("Firearms (") ? "Firearms" : key) + " (\(spec))"
    }
    public func careerLabel(_ item: JSONValue) -> String { local(item) }
    public func careerDescription(_ item: JSONValue) -> String { item["descriptions"][language].string ?? item["description"].text }
    public func formula(_ item: JSONValue) -> String {
        if language == "zh-CN" || item["points"].array.isEmpty { return item["formula"].text }
        return item["points"].array.map { term in term["attrs"].array.map { language == "en" ? $0.text : skillLabel($0.text) }.joined(separator: "/") + "×\(term["mult"].int)" }.joined(separator: " + ")
    }
    public func optionLabel(_ item: JSONValue) -> String { skillLabel(Self.optionKey(item)) + (item["any"].bool ? " *" : "") }
    public static func optionKey(_ item: JSONValue) -> String { item["skill"].text + (item["spec"].text.isEmpty ? "" : " (\(item["spec"].text))") }
    public static func split(_ key: String) -> (String, String) {
        let t = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let p = t.lastIndex(where: { $0 == "(" || $0 == "（" }) else { return (t, "") }
        return (String(t[..<p]).trimmingCharacters(in: .whitespaces), String(t[t.index(after: p)...]).trimmingCharacters(in: CharacterSet(charactersIn: " )）")))
    }
    private static func norm(_ text: String) -> String { text.precomposedStringWithCompatibilityMapping.lowercased().filter { !" _-()（）/.'’:".contains($0) && !$0.isWhitespace } }
}
