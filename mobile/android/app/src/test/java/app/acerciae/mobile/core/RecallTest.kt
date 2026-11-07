package app.acerciae.mobile.core

import org.junit.Assert.*
import org.junit.Test

class RecallTest {
    private fun line(id: String, left: Int? = 120, recalled: String? = null) =
        Message(id = id, content = if (recalled == null) "line $id" else "", authorName = "Ann", kind = "ic", seq = id.hashCode().toLong(), authorId = "u", recalledAt = recalled, recallSecondsLeft = left)

    @Test fun deadlinesComeFromTheFirstCopyAndNeverGrow() {
        var now = 1_000_000L
        val deadlines = RecallDeadlines { now }
        deadlines.note(line("a", 100))
        assertTrue(deadlines.open(line("a", 100)))
        deadlines.note(line("a", 110))          // a later copy saying more time: ignored
        now += 105_000; assertFalse(deadlines.open(line("a")))
        assertFalse("never seen: not offered", deadlines.open(line("b")))
        deadlines.note(line("c", null)); assertFalse(deadlines.open(line("c")))
        deadlines.note(line("d", 30)); assertTrue(deadlines.open(line("d")))
        assertFalse("a tombstone cannot be recalled", deadlines.open(line("d", recalled = "2026-11-07T00:00:00Z")))
    }

    @Test fun aTombstoneTakesItsLinesPlace() {
        val lines = listOf(line("a"), line("b"))
        val stone = line("a", null, "2026-11-07T00:00:00Z")
        assertEquals(listOf("", "line b"), lines.withRecall(stone).map { it.content })
        assertEquals(lines, lines.withRecall(line("z", null, "2026-11-07T00:00:00Z")))
    }

    @Test fun refusalsReadAsCatalogKeys() {
        assertEquals("Messages can only be recalled within 2 minutes of sending.", recallRefusal(BackendException(409, true, "recall_expired")))
        assertEquals("This message can't be recalled.", recallRefusal(BackendException(409, true, "not_recallable")))
        assertNull(recallRefusal(BackendException(403, true, "forbidden")))
    }
}
