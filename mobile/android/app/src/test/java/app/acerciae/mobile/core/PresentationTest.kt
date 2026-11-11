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
    @Test fun everyOutcomeHasItsToneAndRepeatedChecksColourEachLine() {
        listOf("critical" to DiceTone.CRITICAL, "extreme" to DiceTone.EXTREME, "hard" to DiceTone.HARD, "regular" to DiceTone.SUCCESS, "failure" to DiceTone.FAILURE, "fumble" to DiceTone.FUMBLE).forEach { (level, tone) ->
            assertEquals(tone, message("""{"type":"check","rolls":[{"level":"$level"}]}""").diceTone)
        }
        assertEquals(DiceTone.ROLL, message("""{"type":"roll","text":"2d6=8","rolls":[{"total":8}]}""").diceTone)
        assertEquals(DiceTone.NEUTRAL, message("""{"type":"st","text":"STR 50"}""").diceTone)
        val repeated = message("""{"type":"check","text":"one\ntwo\nthree","rolls":[{"level":"hard"},{"level":"fumble"},{"level":"regular"}]}""")
        assertEquals(listOf("one" to DiceTone.HARD, "two" to DiceTone.FUMBLE, "three" to DiceTone.SUCCESS), repeated.diceLines)
        assertEquals(listOf("only" to DiceTone.CRITICAL), message("""{"type":"check","text":"only","rolls":[{"level":"critical"}]}""").diceLines)
        // Dice notation stays plain; the numbers that fell stand out.
        assertEquals(listOf("96", "99", "6", "4", "14"), diceNumberPattern.findAll("D100=96/99, 3d6=[6+4]=14").map { it.value }.toList())
    }
    @Test fun dicePersonaAndDisplayPreference() {
        val bot = message("""{"type":"roll","text":"x","bot":{"name":"Madame Fortune","group_id":"g1","avatar_version":2}}""").diceBot!!
        assertEquals(DiceBot("Madame Fortune", "g1", 2), bot)
        assertNull(message("""{"type":"roll","text":"x"}""").diceBot)
        assertEquals(DiceBot("Dice", "", 0), message("""{"type":"roll","text":"x","bot":{"name":"Dice","avatar_version":0}}""").diceBot)
        fun user(display: String?) = Json.decodeFromString<User>("""{"id":"u","username":"u","display_name":"A"${display?.let { ""","dice_display":"$it"""" } ?: ""}}""")
        assertTrue(DiceDisplay.separate(user(null)))
        assertTrue(DiceDisplay.separate(user("separate")))
        assertFalse(DiceDisplay.separate(user("inline")))
        assertTrue(DiceDisplay.separate(null))
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
