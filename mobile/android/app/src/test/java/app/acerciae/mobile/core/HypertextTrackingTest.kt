package app.acerciae.mobile.core

import org.junit.Assert.*
import org.junit.Test

/** How the app feeds the card store (core/HypertextTracking.kt): when the status is asked, for which cards, when
 *  everything is dropped, and how a line an action posted joins the open window. */
class HypertextTrackingTest {
    private fun view(scope: String = "u1|k", channel: String = "c", window: String = "w", ids: List<String> = emptyList()) = HxTracker.View(scope, channel, window, ids)
    private fun step(reset: Boolean = false, track: Boolean = false, refresh: Boolean = false) = HxTracker.Step(reset, track, refresh)

    @Test fun theStatusIsAskedOnceForNewCardsAndForAllWhenAWindowOpens() {
        val t = HxTracker()
        assertEquals("nothing open yet", step(), t.next(view(channel = "", window = "")))
        // The window opens before its lines arrive: the refresh waits for its first card.
        assertEquals(step(track = true), t.next(view()))
        assertEquals(step(track = true, refresh = true), t.next(view(ids = listOf("a", "b"))))
        assertEquals("a new card: only it is asked", step(track = true), t.next(view(ids = listOf("a", "b", "c"))))
        assertEquals(step(), t.next(view(ids = listOf("a", "b", "c"))))
        // Another window with its lines at once (cached), then back: each opening asks all of its cards again.
        assertEquals(step(track = true, refresh = true), t.next(view(window = "w2", ids = listOf("d"))))
        assertEquals(step(track = true, refresh = true), t.next(view(ids = listOf("a", "b", "c"))))
        // A window without cards keeps its refresh for the first card that comes.
        assertEquals(step(track = true), t.next(view(window = "w3")))
        assertEquals(step(track = true, refresh = true), t.next(view(window = "w3", ids = listOf("e"))))
        assertEquals(step(track = true), t.next(view(window = "w3", ids = listOf("e", "f"))))
    }

    @Test fun aChangeOfAccountChannelOrScopeDropsEverything() {
        val t = HxTracker()
        t.next(view(ids = listOf("a"))); t.next(view(ids = listOf("a")))
        assertEquals("another role or group", step(reset = true, track = true, refresh = true), t.next(view(scope = "u1|k2", ids = listOf("a"))))
        assertEquals("a channel switch empties the chat first", step(reset = true), t.next(view(scope = "u1|", channel = "", window = "")))
        assertEquals(step(reset = true, track = true), t.next(view(scope = "u1|k3", channel = "c2", window = "x")))
        assertEquals(step(track = true, refresh = true), t.next(view(scope = "u1|k3", channel = "c2", window = "x", ids = listOf("z"))))
        assertEquals("signed out", step(reset = true), t.next(view(scope = "", channel = "", window = "")))
    }

    @Test fun theCardsOfAWindowAreItsLinesOfKindHypertextNotRecalled() {
        fun line(id: String, kind: String, recalled: String? = null) = Message(id = id, content = "x", authorName = "GM", kind = kind, seq = 1, recalledAt = recalled)
        assertEquals(listOf("a", "d"), HxTracker.cardIds(listOf(line("a", "hypertext"), line("b", "ic"), line("c", "hypertext", "2026-11-14T00:00:00Z"), line("d", "hypertext"))))
    }

    @Test fun aLinePostedByAnActionJoinsTheOpenWindowOnce() {
        fun line(id: String, seq: Long, channel: String? = "c", window: String? = "w", content: String = "x") = Message(id = id, content = content, authorName = "Ada", kind = "roll", seq = seq, channelId = channel, chatWindowId = window, viaHypertextId = "card")
        val lines = listOf(line("a", 1), line("b", 3))
        assertEquals(listOf("a", "p", "b"), HxChat.withPosted(lines, line("p", 2), "c", "w", emptyMap())!!.map { it.id })
        // Its push (or a refresh) may have brought it already: it is kept once.
        val again = HxChat.withPosted(lines + line("p", 2), line("p", 2, content = "y"), "c", "w", emptyMap())!!
        assertEquals(listOf("a", "p", "b"), again.map { it.id }); assertEquals("y", again[1].content)
        assertNull("another channel", HxChat.withPosted(lines, line("p", 2, channel = "c2"), "c", "w", emptyMap()))
        assertNull("another window", HxChat.withPosted(lines, line("p", 2, window = "w2"), "c", "w", emptyMap()))
        assertNull("no window open", HxChat.withPosted(lines, line("p", 2), "c", "", emptyMap()))
        assertNull("recalled meanwhile", HxChat.withPosted(lines, line("p", 2), "c", "w", mapOf("p" to line("p", 2).copy(recalledAt = "2026-11-14T00:00:00Z"))))
        assertEquals("a row without channel or window ids is the open window's", 3, HxChat.withPosted(lines, line("p", 2, null, null), "c", "w", emptyMap())!!.size)
    }
}
