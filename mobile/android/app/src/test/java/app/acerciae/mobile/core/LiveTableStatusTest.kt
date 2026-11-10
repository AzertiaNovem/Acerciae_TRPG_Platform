package app.acerciae.mobile.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The table status against a real backend: set ACERCIAE_TEST_BASE to a dedicated local test server (mock LLM). The
 * test registers its own accounts and builds its own channel, so the server needs no seed data.
 */
class LiveTableStatusTest {
    private class Follower(address: BackendAddress, client: BackendClient, token: String) : ChatSocket.Listener {
        val flags = TypingFlags(); val other = CopyOnWriteArrayList<String>()
        @Volatile var live = false
        val socket = ChatSocket(address, { client.fileToken(token) }, this)
        override fun event(event: RealtimeEvent) { synchronized(flags) { if (!flags.apply(event)) other.add(event.type) } }
        override fun live(live: Boolean) { this.live = live }
        override fun resync() {}
        fun typing(): Map<String, String> = synchronized(flags) { flags.byCharacter }
    }
    private fun await(what: String, check: () -> Boolean) {
        val start = System.currentTimeMillis()
        while (!check()) { if (System.currentTimeMillis() - start > 15_000) fail("timed out waiting for $what"); Thread.sleep(25) }
    }

    @Test fun typingVitalsInspirationAndPinsAgainstTheServer() = runBlocking {
        val base = System.getenv("ACERCIAE_TEST_BASE")
        assumeTrue("Set ACERCIAE_TEST_BASE to a dedicated local test backend", !base.isNullOrEmpty())
        val address = BackendAddress(base!!, true); val api = BackendClient(address)
        val run = java.util.UUID.randomUUID().toString().take(8)
        val gm = api.register("mgm$run", "password", "Greta"); val player = api.register("mpl$run", "password", "Sam")
        val server = api.resource(listOf("servers"), gm.token, payload("name" to "Mobile table"))
        val channel = api.resource(listOf("servers", server.id, "channels"), gm.token, payload("name" to "Parlour", "knowledge_mode" to "isolated")).id
        api.resource(listOf("channels", channel, "members"), gm.token, payload("username" to "mpl$run", "role" to "player"))
        val window = api.windows(gm.token, channel).first().id
        val ada = api.resource(listOf("channels", channel, "characters"), player.token, buildJsonObject {
            put("name", "Ada"); put("sheet", buildJsonObject { put("attrs", buildJsonObject { put("HP", 3); put("SAN", 55); put("DEX", 60) }) })
        }).id
        api.resource(listOf("channels", channel, "characters", ada, "card"), player.token, buildJsonObject {
            put("role_card", buildJsonObject { put("derived", buildJsonObject { put("hp_max", 12); put("san_max", 70) }) })
        }, "PUT")

        // Vitals come with the character list.
        val row = api.resources(listOf("channels", channel, "characters"), gm.token).first { it.id == ada }
        val parts = Vitals.of(row)
        assertEquals("HP 3/12 · SAN 55/70 · DEX 60", parts.joinToString(" · ") { it.text }); assertTrue(parts[0].low)

        // The player's composer raises Ada's flag; the GM's stream shows it, sees it lowered, and sees it fall with the socket.
        val table = Follower(address, api, gm.token); val writer = Follower(address, api, player.token)
        try {
            table.socket.follow(channel); writer.socket.follow(channel)
            await("both streams") { table.live && writer.live }
            val signal = TypingSignal({ writer.socket.send(it) })
            val target = TypingTarget.of(channel, window, ada)!!
            signal.edited(target, "I")
            await("the flag at the GM's") { table.typing() == mapOf(ada to window) }
            await("the writer's own echo") { writer.typing() == mapOf(ada to window) }
            signal.tick(); signal.edited(target, "I watch")   // no second announcement for an edit
            signal.edited(target, "")
            await("the lowered flag") { table.typing().isEmpty() }
            signal.edited(target, "I watch his hands")
            await("the flag again") { table.typing().containsKey(ada) }
            // Someone who opens the channel now is told at once who is typing.
            val late = Follower(address, api, gm.token)
            try { late.socket.follow(channel); await("the snapshot") { late.typing() == mapOf(ada to window) } } finally { late.socket.close() }
            writer.socket.close()
            await("the flag falling with its socket") { table.typing().isEmpty() }
            assertFalse("typing frames are never passed on as other events", (table.other + writer.other).any { it.startsWith("typing") })
        } finally { table.socket.close(); writer.socket.close() }

        // Inspiration: options in the character's voice; another take sends along what was shown.
        val clue = api.resource(listOf("channels", channel, "windows", window, "messages"), gm.token, payload("content" to "The butler sets down the tray. \"The master saw no one last night,\" he says, not meeting your eyes.", "kind" to "narration"))
        api.resource(listOf("channels", channel, "windows", window, "messages"), player.token, payload("content" to "I watch his hands.", "character_id" to ada))
        val first = api.resource(listOf("channels", channel, "inspiration"), player.token, payload("chat_window_id" to window, "character_id" to ada))
        val options = Inspiration.options(first)
        assertTrue(options.isNotEmpty()); assertEquals(first.text("draft"), options[0].text); assertEquals(ada, first.text("character_id"))
        val shown = Inspiration.shown(emptyList(), first)
        val second = api.resource(listOf("channels", channel, "inspiration"), player.token, buildJsonObject {
            put("chat_window_id", window); put("character_id", ada); put("hint", ""); put("variant", shown.size); put("avoid", JsonArray(shown.map { JsonPrimitive(it) }))
        })
        // The request is taken with what was shown; whether other lines remain is the model's (the mock has few).
        assertTrue(Inspiration.options(second).isNotEmpty()); assertTrue(Inspiration.shown(shown, second).containsAll(shown))

        // Pins: the player pins the butler's line; it heads their hints with their name; they take it down again.
        api.resource(listOf("channels", channel, "messages", clue.id, "pin"), player.token, JsonObject(emptyMap()))
        var reminders = api.resources(listOf("channels", channel, "reminders"), player.token)
        val pin = Pins.of(reminders, clue.id)!!
        assertEquals(reminders.first().id, pin.id); assertEquals("Sam", pin.text("pinned_by_name"))
        assertTrue(Pins.canUnpin(pin, player.user.id, false)); assertFalse(Pins.canUnpin(pin, gm.user.id, false))
        assertNull("the GM's hints are the GM's own", Pins.of(api.resources(listOf("channels", channel, "reminders"), gm.token), clue.id))
        assertTrue(api.resource(listOf("channels", channel, "reminders", pin.id), player.token, method = "DELETE").flag("unpinned"))
        reminders = api.resources(listOf("channels", channel, "reminders"), player.token)
        assertNull(Pins.of(reminders, clue.id))
    }
}
