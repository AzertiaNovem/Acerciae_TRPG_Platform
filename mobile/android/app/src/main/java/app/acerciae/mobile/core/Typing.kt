package app.acerciae.mobile.core

import kotlinx.serialization.json.*

/** A character being written as in a window of a channel: what a typing flag is raised for (docs/API.md). */
data class TypingTarget(val channelId: String, val windowId: String, val characterId: String) {
    fun pack(active: Boolean): JsonObject = buildJsonObject {
        put("type", "typing"); put("channel_id", channelId); put("chat_window_id", windowId); put("character_id", characterId); put("active", active)
    }
    companion object {
        /** Null unless all three are known: the flag is the character's, so writing as oneself raises none. */
        fun of(channelId: String, windowId: String, characterId: String): TypingTarget? =
            if (channelId.isEmpty() || windowId.isEmpty() || characterId.isEmpty()) null else TypingTarget(channelId, windowId, characterId)
    }
}

/**
 * The composer's side of a typing flag. The first edit raises it with a `typing` pack; [tick] (about once a second)
 * sends another every [HEARTBEAT_MS], since the server lets a flag fall 10 s after the last pack, so a lost
 * connection never leaves a character typing; it is lowered as soon as the line is sent or the text cleared, when the
 * writer pauses for [IDLE_MS], or when the window or character changes. [send] may drop a pack while the stream is
 * down: the next heartbeat raises the flag again.
 */
class TypingSignal(private val send: (JsonObject) -> Unit, private val now: () -> Long = { System.currentTimeMillis() }) {
    companion object { const val HEARTBEAT_MS = 4_000L; const val IDLE_MS = 8_000L }
    private var target: TypingTarget? = null
    private var lastEdit = 0L
    private var lastPack = 0L
    /** The character the flag is up for, if any. */
    val raisedFor: String? get() = target?.characterId

    /** The writer changed the text to [text], writing as [to] (null: as nobody a flag can be raised for). */
    fun edited(to: TypingTarget?, text: String) {
        if (to == null || text.isBlank()) { lower(); return }
        if (target != null && target != to) lower()
        lastEdit = now()
        if (target == null) { target = to; lastPack = lastEdit; send(to.pack(true)) }
    }
    fun tick() {
        val current = target ?: return
        val time = now()
        if (time - lastEdit > IDLE_MS) lower()
        else if (time - lastPack >= HEARTBEAT_MS) { lastPack = time; send(current.pack(true)) }
    }
    fun lower() { val current = target ?: return; target = null; send(current.pack(false)) }
    /** The stream was closed: the server dropped the flag with the socket, so nothing is sent. */
    fun forget() { target = null }
}

/**
 * Who is being written as right now: character id to the window it is typed in (the flag is the character's, not the
 * user's), fed by the chat stream's `typing.changed` and `typing.snapshot`. The server announces each flag once when
 * it goes up and once when it falls (heartbeats are not relayed) and sends the whole list after every subscription,
 * so [STALE_MS] is only a last resort for a fall that never arrived.
 */
class TypingFlags(private val now: () -> Long = { System.currentTimeMillis() }) {
    companion object { const val STALE_MS = 10 * 60_000L }
    private class Flag(val windowId: String, val until: Long)
    private val flags = linkedMapOf<String, Flag>()
    val byCharacter: Map<String, String> get() = flags.mapValues { it.value.windowId }

    /** Applies a chat-stream event; true when it was a typing event (changed or not), false for anything else. */
    fun apply(event: RealtimeEvent): Boolean {
        when (event.type) {
            "typing.changed" -> {
                val character = event.payload.text("character_id")
                if (character.isEmpty()) return true
                if (event.payload.flag("active")) flags[character] = Flag(event.payload.text("chat_window_id"), now() + STALE_MS) else flags.remove(character)
            }
            "typing.snapshot" -> {
                flags.clear()
                event.payload.rows("typing").forEach { row -> row.text("character_id").takeIf { it.isNotEmpty() }?.let { flags[it] = Flag(row.text("chat_window_id"), now() + STALE_MS) } }
            }
            else -> return false
        }
        return true
    }
    /** Drops flags past [STALE_MS]; true when one fell. */
    fun prune(): Boolean { val time = now(); return flags.entries.removeAll { it.value.until <= time } }
    fun clear() = flags.clear()
}
