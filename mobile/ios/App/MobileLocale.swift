import SwiftUI
import AcerciaeCore

final class MobileLocale: ObservableObject {
    static let shared = MobileLocale()
    @Published private(set) var language: String
    private let catalog: TranslationCatalog?
    private init() {
        language = InterfaceLanguage.supported(UserDefaults.standard.string(forKey: "interfaceLanguage") ?? Locale.preferredLanguages.first ?? "en")
        catalog = Bundle.main.url(forResource: "mobile-localizations", withExtension: "json")
            .flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(TranslationCatalog.self, from: $0) }
    }
    func set(_ code: String) {
        let code = InterfaceLanguage.supported(code)
        if language != code { language = code }
        UserDefaults.standard.set(code, forKey: "interfaceLanguage")
    }
    func text(_ source: String) -> String { catalog?.text(source, language: language) ?? source }
}
// Only call for application-owned labels, never server-authored chat or character content.
func tr(_ source: String) -> String { MobileLocale.shared.text(source) }

struct LanguagePicker: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var locale = MobileLocale.shared
    var body: some View {
        Picker(tr("Interface language"), selection: Binding(get: { locale.language }, set: { code in Task { await model.changeLanguage(code) } })) {
            ForEach(Array(zip(InterfaceLanguage.codes, InterfaceLanguage.names)), id: \.0) { code, name in Text(name).tag(code) }
        }.disabled(model.busy)
    }
}
