package app.acerciae.mobile.core

import kotlinx.serialization.json.*

/**
 * Server AI providers and model uses (Server options → AI), as on the web; see docs/AI_PROVIDERS.md.
 * The catalog (GET /api/ai/catalog) names the provider kinds, what each can do and its fields, and the uses.
 * A use only takes a provider whose kind has the use's capability.
 */
object AiProviders {
    private fun strings(v: JsonElement?) = (v as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
    fun kinds(catalog: JsonObject) = catalog.rows("kinds")
    fun uses(catalog: JsonObject) = catalog.rows("uses")
    fun kind(catalog: JsonObject, id: String): JsonObject? = kinds(catalog).find { it.id == id }
    fun capabilities(kind: JsonObject?) = strings(kind?.get("capabilities"))
    /** The providers a use may be given: those whose kind can do it. */
    fun fitting(catalog: JsonObject, providers: List<JsonObject>, use: JsonObject) =
        providers.filter { use.text("capability") in capabilities(kind(catalog, it.text("kind"))) }
    /** The use's choices other than a provider: mock, disabled, inherit. */
    fun modes(use: JsonObject) = strings(use["modes"]).filter { it != "provider" }
    fun modeLabel(use: JsonObject, mode: String) = when (mode) {
        "inherit" -> if (use.id == "image_edit") "Same as image generation" else "Same as above"
        "mock" -> when (use.text("capability")) { "text" -> "Mock (no model)"; "tts" -> "Mock speech"; else -> "Mock test patterns" }
        "disabled" -> "Off"
        else -> mode
    }
    /** Model ids the catalog suggests for a provider and capability. */
    fun suggestions(catalog: JsonObject, providerKind: String, capability: String) = strings(kind(catalog, providerKind)?.obj("models")?.get(capability))
    /** The options a use takes with a provider of this kind. */
    fun optionKeys(capability: String, providerKind: String?): List<String> = when (capability) {
        "text" -> if (providerKind in listOf("openai", "responses", "openrouter")) listOf("reasoning_effort") else emptyList()
        "image_generation", "image_edit" -> listOf("size") + if (providerKind == "openai") listOf("quality") else emptyList()
        "tts" -> listOf("voice")
        else -> emptyList()
    }
    fun optionChoices(key: String): List<String>? = when (key) {
        "reasoning_effort" -> listOf("", "minimal", "low", "medium", "high")
        "size" -> listOf("auto", "1024x1024", "1536x1024", "1024x1536")
        "quality" -> listOf("auto", "low", "medium", "high")
        else -> null
    }

    /** A provider being added or edited. secrets: a new value, or null to remove a stored one; absent keeps it. */
    data class Draft(
        val id: String?, val kind: String, val name: String, val apiBase: String,
        val apiKey: String = "", val clearApiKey: Boolean = false,
        val options: Map<String, String> = emptyMap(), val secrets: Map<String, String?> = emptyMap(),
    )
    fun draftOf(provider: JsonObject?, kind: JsonObject, label: String = kind.text("label")) = if (provider == null) Draft(null, kind.id, label, "")
        else Draft(provider.id, provider.text("kind"), provider.name, provider.text("api_base"),
            options = provider.obj("options").mapValues { (it.value as? JsonPrimitive)?.contentOrNull.orEmpty() })
    /** The request body: blank secrets keep what is stored; the kind is only sent when adding. */
    fun body(d: Draft) = buildJsonObject {
        put("name", d.name.trim())
        if (d.id == null) put("kind", d.kind)
        put("api_base", d.apiBase.trim())
        putJsonObject("options") { d.options.forEach { (k, v) -> put(k, v.trim()) } }
        putJsonObject("secrets") { d.secrets.forEach { (k, v) -> if (v == null) put(k, JsonNull) else if (v.isNotBlank()) put(k, v.trim()) } }
        if (d.apiKey.isNotBlank()) put("api_key", d.apiKey.trim())
        if (d.clearApiKey) put("clear_api_key", true)
    }
    /** Whether a provider can be saved: a name, and every required field set (now or already stored). */
    fun ready(d: Draft, kind: JsonObject, stored: JsonObject?): Boolean {
        if (d.name.isBlank()) return false
        return kind.rows("fields").filter { it.flag("required") }.all { f ->
            val key = f.text("key")
            when {
                key == "api_key" -> d.apiKey.isNotBlank() || (stored?.flag("api_key_set") == true && !d.clearApiKey)
                f.text("type") == "secret" -> !d.secrets[key].isNullOrBlank() || (stored?.obj("secrets")?.obj(key)?.flag("set") == true && d.secrets[key] != null)
                else -> !d.options[key].isNullOrBlank()
            }
        }
    }
    /** PUT …/ai/uses: only the uses that changed. */
    fun usesBody(saved: JsonObject, edited: JsonObject) = buildJsonObject {
        putJsonObject("uses") { edited.forEach { (k, v) -> if (saved[k] != v) put(k, v) } }
    }
    /** A use pointed at another choice: the model is kept only when the provider stays. */
    fun choose(use: JsonObject, choice: String) = buildJsonObject {
        put("provider", choice); put("model", if (choice == use.text("provider")) use.text("model") else ""); put("options", use.obj("options"))
    }
}
