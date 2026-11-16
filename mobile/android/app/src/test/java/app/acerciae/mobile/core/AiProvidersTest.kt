package app.acerciae.mobile.core

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AiProvidersTest {
    private val catalog = Json.parseToJsonElement("""{
      "kinds": [
        {"id": "openai", "label": "OpenAI-compatible", "capabilities": ["text", "embedding", "image_generation", "image_edit", "tts"], "default_api_base": "https://api.openai.com/v1",
         "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}], "models": {"text": ["gpt-5.1"]}},
        {"id": "stability", "label": "Stability AI", "capabilities": ["image_generation", "image_edit"], "default_api_base": "https://api.stability.ai",
         "fields": [{"key": "api_key", "label": "API key", "type": "secret", "required": true}], "models": {}},
        {"id": "aws", "label": "AWS", "capabilities": ["embedding", "tts"], "default_api_base": "https://bedrock-runtime.{region}.amazonaws.com",
         "fields": [{"key": "region", "label": "Region", "type": "text", "required": true}, {"key": "access_key_id", "label": "Access key ID", "type": "text", "required": true},
                    {"key": "api_key", "label": "Secret access key", "type": "secret", "required": true}, {"key": "session_token", "label": "Session token", "type": "secret", "required": false}], "models": {}}],
      "uses": [
        {"id": "text", "capability": "text", "modes": ["provider", "mock"], "default": "mock", "label": "Text"},
        {"id": "image_edit", "capability": "image_edit", "modes": ["inherit", "provider", "mock", "disabled"], "default": "inherit", "label": "Image editing"},
        {"id": "embedding", "capability": "embedding", "modes": ["provider", "disabled"], "default": "disabled", "label": "Embedding"}]
    }""").jsonObject
    private val providers = listOf(
        buildJsonObject { put("id", "p1"); put("name", "Gateway"); put("kind", "openai") },
        buildJsonObject { put("id", "p2"); put("name", "Stability"); put("kind", "stability") })

    @Test fun usesOnlyOfferProvidersThatCanDoThem() {
        val uses = AiProviders.uses(catalog)
        assertEquals(listOf("p1"), AiProviders.fitting(catalog, providers, uses[0]).map { it.id })
        assertEquals(listOf("p1", "p2"), AiProviders.fitting(catalog, providers, uses[1]).map { it.id })
        assertEquals(listOf("mock"), AiProviders.modes(uses[0]))
        assertEquals("Same as image generation", AiProviders.modeLabel(uses[1], "inherit"))
        assertEquals("Mock test patterns", AiProviders.modeLabel(uses[1], "mock"))
        assertEquals(listOf("reasoning_effort"), AiProviders.optionKeys("text", "openai"))
        assertEquals(emptyList<String>(), AiProviders.optionKeys("text", "anthropic"))
        assertEquals(listOf("size"), AiProviders.optionKeys("image_edit", "stability"))
        assertEquals(listOf("gpt-5.1"), AiProviders.suggestions(catalog, "openai", "text"))
    }

    @Test fun providerBodiesKeepStoredSecretsUnlessReplacedOrRemoved() {
        val aws = AiProviders.kind(catalog, "aws")!!
        val fresh = AiProviders.draftOf(null, aws)
        assertFalse(AiProviders.ready(fresh, aws, null))
        val filled = fresh.copy(options = mapOf("region" to " us-west-2 ", "access_key_id" to "AKID"), apiKey = "secret", secrets = mapOf("session_token" to ""))
        assertTrue(AiProviders.ready(filled, aws, null))
        val body = AiProviders.body(filled)
        assertEquals("aws", body.text("kind")); assertEquals("us-west-2", body.obj("options").text("region"))
        assertEquals("secret", body.text("api_key")); assertFalse(body.obj("secrets").containsKey("session_token"))
        val stored = Json.parseToJsonElement("""{"id": "p3", "name": "AWS", "kind": "aws", "api_base": "", "api_key_set": true, "api_key_hint": "…cret",
            "options": {"region": "us-west-2", "access_key_id": "AKID"}, "secrets": {"session_token": {"set": true, "hint": "set"}}}""").jsonObject
        val edit = AiProviders.draftOf(stored, aws)
        assertTrue(AiProviders.ready(edit, aws, stored))   // the stored key counts
        val update = AiProviders.body(edit.copy(secrets = mapOf("session_token" to null)))
        assertFalse(update.containsKey("kind")); assertFalse(update.containsKey("api_key"))
        assertEquals(JsonNull, update.obj("secrets")["session_token"])
        assertFalse(AiProviders.ready(edit.copy(clearApiKey = true), aws, stored))
    }

    @Test fun onlyChangedUsesAreSent() {
        val saved = Json.parseToJsonElement("""{"text": {"provider": "mock", "model": "", "options": {}}, "embedding": {"provider": "disabled", "model": "", "options": {}}}""").jsonObject
        val chosen = AiProviders.choose(saved.obj("text"), "p1")
        assertEquals("", chosen.text("model"))
        val edited = JsonObject(saved + ("text" to JsonObject(chosen + ("model" to JsonPrimitive("gpt-5.1")))))
        val body = AiProviders.usesBody(saved, edited).obj("uses")
        assertEquals(setOf("text"), body.keys); assertEquals("p1", body.obj("text").text("provider"))
        val same = AiProviders.choose(body.obj("text"), "p1")
        assertEquals("gpt-5.1", same.text("model"))   // the same provider keeps its model
    }
}
