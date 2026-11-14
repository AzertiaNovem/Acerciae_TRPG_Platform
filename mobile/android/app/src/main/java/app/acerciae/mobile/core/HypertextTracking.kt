package app.acerciae.mobile.core

// How the app feeds the card store (HypertextStore) from what it shows, as the web's MessageList and useRealtime do:
// the status of every card loaded in the open window is asked once, and for all of them again when a window is
// opened; everything is dropped when the account, the channel or the knowledge scope changes. Spectators and the demo
// never come here.

/** Follows what the chat shows and says what the store has to do about it ([HypertextStore.reset] and track). */
class HxTracker {
    /** [scope]: who is signed in with which access (AppState.scopeKey, which includes the channel); the open channel
     *  and window ("" for none); the cards loaded there ([cardIds]). */
    data class View(val scope: String, val channelId: String, val windowId: String, val ids: List<String>)
    /** [reset]: drop every card first. [track]: give the store the window's cards; [refresh]: ask all of them again. */
    data class Step(val reset: Boolean, val track: Boolean, val refresh: Boolean)

    private var last: View? = null
    // A window was opened and its cards have not been asked again yet. The lines of a window arrive after it is
    // opened (from the cache, then the server), so the refresh waits for the first card.
    private var opening = false

    fun next(v: View): Step {
        val prev = last
        last = v
        val reset = prev != null && prev.scope != v.scope
        if (prev == null || reset || prev.channelId != v.channelId || prev.windowId != v.windowId) opening = true
        if (v.channelId.isEmpty() || v.windowId.isEmpty()) return Step(reset, track = false, refresh = false)
        val refresh = opening && v.ids.isNotEmpty()
        if (refresh) opening = false
        val changed = prev == null || reset || prev.channelId != v.channelId || prev.ids != v.ids
        return Step(reset, changed || refresh, refresh)
    }

    companion object {
        /** The cards among a window's lines: kind hypertext and not recalled (lines of a fork's parent included; they
         *  are drawn as history). */
        fun cardIds(lines: List<Message>): List<String> = lines.filter { it.kind == Hypertext.KIND && !it.recalled }.map { it.id }
    }
}

object HxChat {
    /** The open window's lines with one an action posted (a reply the viewer may read, or their own line), shown at
     *  once; its push or the next refresh brings the same row, kept once by id. Null when the line is not the open
     *  window's, or was recalled meanwhile. */
    fun withPosted(lines: List<Message>, posted: Message, channelId: String, windowId: String, recalled: Map<String, Message>): List<Message>? {
        if (channelId.isEmpty() || windowId.isEmpty()) return null
        if (!posted.channelId.isNullOrEmpty() && posted.channelId != channelId) return null
        if (!posted.chatWindowId.isNullOrEmpty() && posted.chatWindowId != windowId) return null
        if (posted.recalled || recalled.containsKey(posted.id)) return null
        return ChatHistory.merge(lines, listOf(posted), recalled)
    }
}
