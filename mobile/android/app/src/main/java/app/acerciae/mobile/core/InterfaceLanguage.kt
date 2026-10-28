package app.acerciae.mobile.core

import kotlinx.serialization.Serializable

object InterfaceLanguage {
    val codes = listOf("en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "ru", "pt", "it")
    val names = listOf("English", "简体中文", "繁體中文", "日本語", "한국어", "Español", "Français", "Deutsch", "Русский", "Português", "Italiano")
    fun supported(value: String): String = when {
        value in codes -> value
        value.startsWith("zh") -> if (listOf("Hant", "TW", "HK").any { value.contains(it) }) "zh-TW" else "zh-CN"
        value.take(2) in codes -> value.take(2)
        else -> "en"
    }
}
@Serializable class TranslationCatalog(val catalog: Map<String, List<String>>, val aliases: Map<String, String>) {
    fun text(source: String, language: String): String {
        val trimmed = source.trim()
        val key = aliases[trimmed] ?: aliases[source] ?: trimmed
        val code = InterfaceLanguage.supported(language)
        if (code == "zh-CN" && aliases.containsKey(source)) return source
        if (!aliases.containsKey(source) && !aliases.containsKey(trimmed) && !catalog.containsKey(key)) return source
        val index = InterfaceLanguage.codes.indexOf(code) - 1
        val translated = if (index >= 0) catalog[key]?.getOrNull(index) ?: key else key
        return source.replace(trimmed, translated)
    }
}
