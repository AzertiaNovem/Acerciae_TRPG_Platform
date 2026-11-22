package app.acerciae.mobile.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** Bots: a bot's line and a character a bot plays carry the flag the "bot" tag reads; older servers send neither. */
class BotTagTest {
    @Test fun botFlagsSurviveDecodingAndOlderServersStayCompatible() {
        val json = Json { ignoreUnknownKeys = true }
        val fixture = json.decodeFromString<JsonObject>(javaClass.classLoader!!.getResourceAsStream("bots.json")!!.bufferedReader().use { it.readText() })
        val message = json.decodeFromString<Message>(fixture["message"].toString())
        assertTrue(message.authorIsBot)
        assertFalse(json.decodeFromString<Message>(fixture["legacy_message"].toString()).authorIsBot)
        assertTrue((fixture["character"] as JsonObject).flag("player_is_bot"))
        assertFalse((fixture["legacy_character"] as JsonObject).flag("player_is_bot"))
    }
}
