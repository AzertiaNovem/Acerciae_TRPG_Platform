import Foundation

/// Server AI providers and model uses (Server options → AI), as on the web; see docs/AI_PROVIDERS.md.
/// The catalog (GET /api/ai/catalog) names the provider kinds, what each can do and its fields, and the uses.
/// A use only takes a provider whose kind has the use's capability.
public enum AiProviders {
    public static func kinds(_ catalog: JSONValue) -> [JSONValue] { catalog["kinds"].array }
    public static func uses(_ catalog: JSONValue) -> [JSONValue] { catalog["uses"].array }
    public static func kind(_ catalog: JSONValue, _ id: String) -> JSONValue? { kinds(catalog).first { $0["id"].text == id } }
    public static func capabilities(_ kind: JSONValue?) -> [String] { kind?["capabilities"].array.compactMap(\.string) ?? [] }
    /// The providers a use may be given: those whose kind can do it.
    public static func fitting(_ catalog: JSONValue, providers: [JSONValue], use: JSONValue) -> [JSONValue] {
        providers.filter { capabilities(kind(catalog, $0["kind"].text)).contains(use["capability"].text) }
    }
    /// The use's choices other than a provider: mock, disabled, inherit.
    public static func modes(_ use: JSONValue) -> [String] { use["modes"].array.compactMap(\.string).filter { $0 != "provider" } }
    public static func modeLabel(_ use: JSONValue, _ mode: String) -> String {
        switch mode {
        case "inherit": use["id"].text == "image_edit" ? "Same as image generation" : "Same as above"
        case "mock": use["capability"].text == "text" ? "Mock (no model)" : use["capability"].text == "tts" ? "Mock speech" : "Mock test patterns"
        case "disabled": "Off"
        default: mode
        }
    }
    /// Model ids the catalog suggests for a provider kind and capability.
    public static func suggestions(_ catalog: JSONValue, kind: String, capability: String) -> [String] {
        AiProviders.kind(catalog, kind)?["models"][capability].array.compactMap(\.string) ?? []
    }
    /// The options a use takes with a provider of this kind.
    public static func optionKeys(capability: String, providerKind: String?) -> [String] {
        switch capability {
        case "text": ["openai", "responses", "openrouter"].contains(providerKind ?? "") ? ["reasoning_effort"] : []
        case "image_generation", "image_edit": providerKind == "openai" ? ["size", "quality"] : ["size"]
        case "tts": ["voice"]
        default: []
        }
    }
    public static func optionChoices(_ key: String) -> [String]? {
        switch key {
        case "reasoning_effort": ["", "minimal", "low", "medium", "high"]
        case "size": ["auto", "1024x1024", "1536x1024", "1024x1536"]
        case "quality": ["auto", "low", "medium", "high"]
        default: nil
        }
    }

    /// A provider being added or edited. Blank secrets keep what is stored; `removedSecrets` removes stored ones.
    public struct Draft: Equatable, Sendable {
        public var id: String?
        public var kind: String
        public var name: String
        public var apiBase: String
        public var apiKey = ""
        public var clearApiKey = false
        public var options: [String: String] = [:]
        public var secrets: [String: String] = [:]
        public var removedSecrets: Set<String> = []
        public init(id: String?, kind: String, name: String, apiBase: String, options: [String: String] = [:]) {
            self.id = id; self.kind = kind; self.name = name; self.apiBase = apiBase; self.options = options
        }
    }
    public static func draft(of provider: JSONValue?, kind: JSONValue, label: String? = nil) -> Draft {
        guard let provider, provider != .null else { return Draft(id: nil, kind: kind["id"].text, name: label ?? kind["label"].text, apiBase: "") }
        return Draft(id: provider["id"].text, kind: provider["kind"].text, name: provider["name"].text, apiBase: provider["api_base"].text,
                     options: provider["options"].object.compactMapValues(\.string))
    }
    /// The request body; the kind is only sent when adding.
    public static func body(_ d: Draft) -> JSONValue {
        var o: [String: JSONValue] = ["name": .string(d.name.trimmingCharacters(in: .whitespaces)), "api_base": .string(d.apiBase.trimmingCharacters(in: .whitespaces))]
        if d.id == nil { o["kind"] = .string(d.kind) }
        o["options"] = .object(d.options.mapValues { .string($0.trimmingCharacters(in: .whitespaces)) })
        var secrets: [String: JSONValue] = [:]
        for (k, v) in d.secrets where !v.trimmingCharacters(in: .whitespaces).isEmpty { secrets[k] = .string(v.trimmingCharacters(in: .whitespaces)) }
        for k in d.removedSecrets { secrets[k] = .null }
        o["secrets"] = .object(secrets)
        if !d.apiKey.trimmingCharacters(in: .whitespaces).isEmpty { o["api_key"] = .string(d.apiKey.trimmingCharacters(in: .whitespaces)) }
        if d.clearApiKey { o["clear_api_key"] = .bool(true) }
        return .object(o)
    }
    /// Whether a provider can be saved: a name, and every required field set (now or already stored).
    public static func ready(_ d: Draft, kind: JSONValue, stored: JSONValue?) -> Bool {
        guard !d.name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        return kind["fields"].array.filter { $0["required"].bool }.allSatisfy { f in
            let key = f["key"].text
            if key == "api_key" { return !d.apiKey.trimmingCharacters(in: .whitespaces).isEmpty || (stored?["api_key_set"].bool == true && !d.clearApiKey) }
            if f["type"].text == "secret" { return !(d.secrets[key] ?? "").isEmpty || (stored?["secrets"][key]["set"].bool == true && !d.removedSecrets.contains(key)) }
            return !(d.options[key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        }
    }
    /// PUT …/ai/uses: only the uses that changed.
    public static func usesBody(saved: JSONValue, edited: [String: JSONValue]) -> JSONValue {
        .object(["uses": .object(edited.filter { saved[$0.key] != $0.value })])
    }
    /// A use pointed at another choice: the model is kept only when the provider stays.
    public static func choose(_ use: JSONValue, _ choice: String) -> JSONValue {
        .object(["provider": .string(choice), "model": .string(choice == use["provider"].text ? use["model"].text : ""), "options": .object(use["options"].object)])
    }
}
