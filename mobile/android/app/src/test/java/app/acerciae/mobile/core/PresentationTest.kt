package app.acerciae.mobile.core

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class PresentationTest {
    private fun message(dice: String) = Json.decodeFromString<Message>("""{"id":"m","content":".rh 1d100","author_name":"A","kind":"roll","seq":1,"dice":$dice}""")
    @Test fun avatarMetadataDecodesWithoutBreakingLegacyMessages() {
        val message = Json.decodeFromString<Message>("""{"id":"m","content":"hello","author_name":"A","kind":"ic","seq":1,"character_id":"c","character_avatar_asset_id":"a","character_avatar_version":4,"author_avatar_version":2}""")
        assertEquals("c", message.characterId)
        assertEquals("a", message.characterAvatarAssetId)
        assertEquals(4, message.characterAvatarVersion)
        assertEquals(2, message.authorAvatarVersion)
        val user = Json.decodeFromString<User>("""{"id":"u","username":"u","display_name":"A","avatar_data":"data:image/png;base64,eA==","avatar_version":3}""")
        assertEquals(3, user.avatarVersion)
        assertTrue(user.avatarData!!.startsWith("data:image/png"))
    }
    @Test fun diceTonesAndHiddenNotice() {
        listOf("""{"level":"critical"}""" to DiceTone.CRITICAL, """{"level":"fumble"}""" to DiceTone.FUMBLE, """{"success":true}""" to DiceTone.SUCCESS, """{"success":false}""" to DiceTone.FAILURE, """{"rolls":[{"level":"critical"},{"success":false}]}""" to DiceTone.FAILURE, """{"success":true,"rolls":[{"success":false}]}""" to DiceTone.SUCCESS).forEach { (payload, tone) ->
            assertEquals(tone, message(payload).diceTone)
            assertEquals(".rh 1d100", message(payload).diceCommand)
        }
        val hidden = message("""{"type":"hidden_notice","text":"A made a hidden roll."}""")
        assertEquals(DiceTone.NOTICE, hidden.diceTone)
        assertNull(hidden.diceCommand)
        assertEquals("A made a hidden roll.", hidden.displayText)
        assertEquals("", message("""{"type":"hidden_notice"}""").displayText)
    }
    @Test fun packagedLanguagesAndContentBoundary() {
        val catalog = Json.decodeFromString<TranslationCatalog>(File("src/main/assets/mobile-localizations.json").readText())
        assertEquals(11, InterfaceLanguage.codes.size)
        assertEquals("zh-TW", InterfaceLanguage.supported("zh-Hant-HK"))
        assertEquals("ja", InterfaceLanguage.supported("ja-JP"))
        assertEquals("en", InterfaceLanguage.supported("xx"))
        catalog.catalog.values.forEach { assertEquals(10, it.size); assertFalse(it.contains("")) }
        assertEquals("Character home", catalog.text("角色主页", "en"))
        assertEquals("角色主页", catalog.text("角色主页", "zh-CN"))
        assertNotEquals("角色主页", catalog.text("角色主页", "ja"))
        InterfaceLanguage.codes.forEach { assertEquals("调查员自定义台词 9d8", catalog.text("调查员自定义台词 9d8", it)) }
    }
}
