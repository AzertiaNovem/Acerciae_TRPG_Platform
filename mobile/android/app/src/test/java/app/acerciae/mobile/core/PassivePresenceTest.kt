package app.acerciae.mobile.core

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class PassivePresenceTest {
    @Test fun standInSurvivesDecodingWithNoRecallDeadlineAndOlderServersStayCompatible() {
        val json = Json { ignoreUnknownKeys = true }
        val marked = json.decodeFromString<Message>("""{"id":"line","content":"Let me think.","author_name":"Host","author_id":"gm","character_id":"pc","kind":"ic","seq":1,"stand_in":true,"recall_seconds_left":null}""")
        assertTrue(marked.standIn)
        assertNull(marked.recallSecondsLeft)
        val old = json.decodeFromString<Message>("""{"id":"old","content":"Hello.","author_name":"Alice","kind":"ic","seq":1}""")
        assertFalse(old.standIn)
    }
}
