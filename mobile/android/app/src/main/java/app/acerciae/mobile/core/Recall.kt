package app.acerciae.mobile.core

/**
 * When each of the user's own lines stops being recallable: `recall_seconds_left` of the first copy that arrived,
 * on this device's clock (a later copy can shorten it, never extend it). The server decides in the end.
 */
class RecallDeadlines(private val now: () -> Long = { System.currentTimeMillis() }) {
    private val until = mutableMapOf<String, Long>()
    fun note(messages: List<Message>) { messages.forEach(::note) }
    fun note(m: Message) {
        val left = m.recallSecondsLeft ?: return
        if (m.recalled) return
        val at = now() + left * 1000L
        if ((until[m.id] ?: Long.MAX_VALUE) > at) until[m.id] = at
        if (until.size > 200) { val t = now(); until.entries.removeAll { it.value <= t } }
    }
    fun open(m: Message): Boolean { val at = until[m.id] ?: return false; return !m.recalled && at > now() }
    fun clear() = until.clear()
}

/** The lines with [tombstone] in its line's place (unchanged when the line is not there). */
fun List<Message>.withRecall(tombstone: Message): List<Message> = map { if (it.id == tombstone.id) tombstone else it }

/** A refused recall in the interface's words (catalog keys); null when it was not a recall refusal. */
fun recallRefusal(e: Exception): String? = when ((e as? BackendException)?.code) {
    "recall_expired" -> "Messages can only be recalled within 2 minutes of sending."
    "not_recallable" -> "This message can't be recalled."
    else -> null
}
