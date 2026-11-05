package app.acerciae.mobile

import app.acerciae.mobile.core.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class SavedAccountsTest {
    @Test fun oldLoginSurvivesAddingSwitchingAndRemovingAnotherAccount() {
        fun login(id: String, token: String) = SavedLogin(ServiceConfiguration.BACKEND_ROOT, Session(token, User(id,id,id)))
        val a = login("one", "first")
        val b = login("two", "second")
        var roster = SavedAccounts.decode(Json.encodeToString(a))
        assertEquals("one", roster.active)
        roster = roster.selecting(null)
        assertNull(roster.active)
        roster = roster.remember(b).remember(login("one", "renewed"))
        assertEquals(2, roster.accounts.size)
        assertEquals("renewed", roster.accounts.first { it.session.user.id == "one" }.session.token)
        roster = SavedAccounts.decode(Json.encodeToString(roster.selecting("two")))
        assertEquals("two", roster.active)
        roster = roster.removing("two")
        assertNull(roster.active)
        assertEquals("renewed", roster.selecting("one").accounts.single().session.token)
        assertThrows(IllegalArgumentException::class.java) { roster.selecting("unknown") }
    }
}
