package app.acerciae.mobile

import android.content.Context
import androidx.compose.runtime.*
import app.acerciae.mobile.core.*
import kotlinx.serialization.json.Json
import java.util.Locale

object MobileLocale {
    var language by mutableStateOf("en")
        private set
    private var catalog: TranslationCatalog? = null
    private var preferences: android.content.SharedPreferences? = null
    fun initialize(context: Context) {
        if (preferences != null) return
        preferences = context.getSharedPreferences("interface_language", Context.MODE_PRIVATE)
        language = InterfaceLanguage.supported(preferences?.getString("language", null) ?: Locale.getDefault().toLanguageTag())
        catalog = context.assets.open("mobile-localizations.json").bufferedReader().use { Json.decodeFromString<TranslationCatalog>(it.readText()) }
    }
    fun set(code: String) {
        language = InterfaceLanguage.supported(code)
        preferences?.edit()?.putString("language", language)?.apply()
    }
    fun text(source: String): String = catalog?.text(source, language) ?: source
}
// Only application-owned strings; never translate chat, character names or log content.
fun tr(source: String) = MobileLocale.text(source)

@Composable fun LanguagePicker(state: AppState, model: AppViewModel) {
    Choice(tr("Interface language"), MobileLocale.language, InterfaceLanguage.codes.zip(InterfaceLanguage.names), !state.busy) { model.changeLanguage(it) }
}
