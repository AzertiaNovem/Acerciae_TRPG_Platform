package app.acerciae.mobile.core
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class WindowActivityTest {
    private fun j(text:String)=Json.parseToJsonElement(text).jsonObject
    @Test fun noticesOnlyForNewMessagesInJoinedUnviewedWindows() {
        val old=j("""{"id":"w","last_seq":8}""")
        val joined=j("""{"id":"w","kind":"private","last_seq":9,"unread":1,"members":[{"user_id":"me"}]}""")
        assertTrue(WindowActivity.shouldNotify(old,joined,"me","other"))
        assertFalse(WindowActivity.shouldNotify(null,joined,"me","other"))
        assertFalse(WindowActivity.shouldNotify(old,joined,"me","w"))
        assertFalse(WindowActivity.shouldNotify(old,joined,"gm-not-a-member","other"))
        assertFalse(WindowActivity.shouldNotify(joined,joined,"me","other"))
        assertFalse(WindowActivity.shouldNotify(old,j("""{"id":"w","kind":"main","last_seq":10,"unread":0}"""),"me","other"))
        assertTrue(WindowActivity.shouldNotify(old,j("""{"id":"w","kind":"main","last_seq":10,"unread":1}"""),"me","other"))
    }
    @Test fun pbtaMoveShowsItsFrozenOutcome() {
        val m=Json { ignoreUnknownKeys=true }.decodeFromString<Message>("""{"id":"m","content":".move search","author_name":"Scout","kind":"roll","seq":1,"dice":{"type":"pbta_move","rolls":[3,4],"text":"有所取舍 · 选择一项代价"}}""")
        assertEquals("有所取舍 · 选择一项代价",m.displayText)
        assertEquals(DiceTone.NEUTRAL,m.diceTone)
    }
    @Test fun dndIntegerRollsCriticalAndOocSpeaker() {
        val m=Json { ignoreUnknownKeys=true }.decodeFromString<Message>("""{"id":"m","content":".rc attack","kind":"ooc","seq":2,"author_name":"Player","character_name":"Character","dice":{"type":"d20","rolls":[3,20],"critical":true,"success":true,"text":"Attack 20: critical"}}""")
        assertEquals(DiceTone.CRITICAL,m.diceTone); assertEquals("Attack 20: critical",m.displayText); assertEquals("Player",WindowActivity.speaker(m))
    }
}
