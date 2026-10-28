package app.acerciae.mobile.core

import kotlinx.serialization.json.*
import java.text.Normalizer

class RuleNames(val rules: JsonObject, language: String) {
    val language = InterfaceLanguage.supported(language)
    private val entries get() = rules.rows("skills") + rules.rows("families") + rules.rows("characteristics")
    private fun local(item: JsonObject) = item.obj("names").text(language).ifEmpty { item.name }
    fun skillLabel(key: String): String {
        entries.find { it.name == key }?.let { return local(it) }
        val (family, spec) = split(key)
        val item = entries.find { it.name == family } ?: return key
        if (spec.isEmpty()) return key
        return local(item) + if (language.startsWith("zh") || language == "ja") "（$spec）" else if (language == "ko") "($spec)" else " ($spec)"
    }
    fun skillKey(text: String): String {
        fun find(s: String) = entries.find { norm(it.name) == norm(s) || norm(local(it)) == norm(s) }
        val t = text.trim(); if (t.isEmpty()) return t
        find(t)?.let { return when (it.name) { "Fighting" -> "Fighting (Brawl)"; "Firearms" -> "Firearms (Handgun)"; else -> it.name } }
        val (f, spec) = split(t); if (spec.isEmpty()) return t
        val item = find(f) ?: return t
        return (if (item.name == "Fighting (Brawl)") "Fighting" else if (item.name.startsWith("Firearms (")) "Firearms" else item.name) + " ($spec)"
    }
    fun careerLabel(item: JsonObject) = local(item)
    fun careerDescription(item: JsonObject) = item.obj("descriptions").text(language).ifEmpty { item.text("description") }
    fun formula(item: JsonObject): String = if (language == "zh-CN" || item.rows("points").isEmpty()) item.text("formula") else item.rows("points").joinToString(" + ") { term -> (term["attrs"] as? JsonArray).orEmpty().joinToString("/") { if (language == "en") it.jsonPrimitive.content else skillLabel(it.jsonPrimitive.content) } + "×${term.number("mult")}" }
    fun optionLabel(item: JsonObject) = skillLabel(optionKey(item)) + if (item.flag("any")) " *" else ""
    companion object {
        fun optionKey(item: JsonObject) = item.text("skill") + item.text("spec").let { if (it.isEmpty()) "" else " ($it)" }
        fun split(key: String): Pair<String,String> { val t = key.trim(); val p = t.indexOfLast { it == '(' || it == '（' }; return if (p < 0) t to "" else t.substring(0,p).trim() to t.substring(p+1).trim(' ', ')', '）') }
        private fun norm(s: String) = Normalizer.normalize(s, Normalizer.Form.NFKC).lowercase().filter { !it.isWhitespace() && it !in "_-()（）/.'’:" }
    }
}
