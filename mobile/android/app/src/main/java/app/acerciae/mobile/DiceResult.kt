package app.acerciae.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.*
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.*
import app.acerciae.mobile.core.*

/** The palette shared with the web: one colour per outcome. */
fun diceColor(tone: DiceTone): Color = when (tone) {
    DiceTone.CRITICAL -> Color(0xFFF2B72F)
    DiceTone.EXTREME -> Color(0xFFB77CF2)
    DiceTone.HARD -> Color(0xFF4FA3F7)
    DiceTone.SUCCESS -> Color(0xFF3FBF74)
    DiceTone.FAILURE -> Color(0xFFEF8A3C)
    DiceTone.FUMBLE -> Color(0xFFEF4B5B)
    DiceTone.ROLL -> Color(0xFF36C2C2)
    DiceTone.NEUTRAL, DiceTone.NOTICE -> Color(0xFF8B97A8)
}
/** A result line with its numbers in bold, in the line's colour. */
private fun withNumbers(line: String, tone: Color) = buildAnnotatedString {
    var at = 0
    diceNumberPattern.findAll(line).forEach { m ->
        append(line.substring(at, m.range.first))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = tone)) { append(m.value) }
        at = m.range.last + 1
    }
    append(line.substring(at))
}

/** A roll's result card; showCommand adds the typed command above it (results shown under the command). */
@Composable fun DiceResult(message: Message, showCommand: Boolean = true) {
    val emphasized = message.diceTone in listOf(DiceTone.CRITICAL, DiceTone.FUMBLE)
    val tone = if (message.diceTone == DiceTone.NOTICE) MaterialTheme.colorScheme.onSurfaceVariant else diceColor(message.diceTone)
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        if (showCommand) message.diceCommand?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        Surface(color = tone.copy(alpha = if (emphasized) .2f else .12f), shape = RoundedCornerShape(12.dp), border = BorderStroke(if (emphasized) 1.5.dp else 1.dp, tone.copy(alpha = if (emphasized) .95f else .55f))) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                Box(Modifier.width(4.dp).fillMaxHeight().background(tone))
                Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                Canvas(Modifier.padding(top = 3.dp).size(18.dp)) {
                    drawRoundRect(tone, cornerRadius = CornerRadius(3.dp.toPx()), style = Stroke(1.5.dp.toPx()))
                    listOf(.25f to .25f, .75f to .25f, .5f to .5f, .25f to .75f, .75f to .75f).forEach { (x,y) -> drawCircle(tone, 1.5.dp.toPx(), Offset(size.width*x, size.height*y)) }
                }
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    if (message.dice?.flag("hidden") == true || message.diceTone == DiceTone.NOTICE) Text(tr("暗骰"), style = MaterialTheme.typography.labelSmall, color = tone)
                    val dice = message.dice
                    if(dice!=null && message.hasStructuredPbtaResult) {
                        Text(dice.text("name"),style=MaterialTheme.typography.titleMedium)
                        Text(dice.text("trigger"),style=MaterialTheme.typography.bodySmall)
                        val rolls = (dice["rolls"] as? kotlinx.serialization.json.JsonArray).orEmpty()
                        if(rolls.isNotEmpty()) {
                            if(dice.text("stat_name").isNotEmpty()) Text(dice.text("stat_name"),style=MaterialTheme.typography.bodySmall)
                            Text("2d6 ["+rolls.joinToString(", ")+ "] + ${dice.number("stat_value")} + (${dice.number("modifier")}) = ${dice.number("total")}",fontFamily=FontFamily.Monospace)
                            Text(dice.obj("band").name,fontWeight=FontWeight.SemiBold)
                            SelectionContainer { Text(dice.text("outcome")) }
                        }
                        if(dice.flag("player_choice")) Text(tr("Player choice"),style=MaterialTheme.typography.bodySmall)
                    } else if (message.diceTone == DiceTone.NOTICE) SelectionContainer { Text(message.displayText, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    else SelectionContainer {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            val lines = message.diceLines
                            lines.forEach { (line, lineTone) ->
                                val c = diceColor(lineTone)
                                Row(Modifier.height(IntrinsicSize.Min)) {
                                    if (lines.size > 1) { Box(Modifier.width(2.dp).fillMaxHeight().background(c)); Spacer(Modifier.width(6.dp)) }
                                    Text(withNumbers(line, c), fontWeight = if (emphasized) FontWeight.SemiBold else FontWeight.Normal, color = MaterialTheme.colorScheme.onSurface)
                                }
                            }
                        }
                    }
                }
                }
            }
        }
    }
}

private val diceAvatars = LruCache<String, Bitmap>(16)
/** The dice persona's picture (uploaded to the channel's text group), or a die in the outcome's colour. */
@Composable fun DiceAvatar(bot: DiceBot?, tone: Color, model: AppViewModel, size: Dp = 32.dp) {
    val key = bot?.takeIf { it.groupId.isNotEmpty() && it.avatarVersion > 0 }?.let { "${it.groupId}:${it.avatarVersion}" }
    var bitmap by remember(key) { mutableStateOf(key?.let { diceAvatars.get(it) }) }
    LaunchedEffect(key) {
        if (key == null || bitmap != null) return@LaunchedEffect
        try {
            val bytes = model.bytes(listOf("dice-avatars", bot!!.groupId), mapOf("v" to bot.avatarVersion.toString()))
            val decoded = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
            if (decoded != null) { diceAvatars.put(key, decoded); bitmap = decoded }
        } catch (e: CancellationException) { throw e } catch (_: Exception) { bitmap = null }
    }
    Box(Modifier.size(size).clip(CircleShape).background(tone.copy(alpha = .3f)), contentAlignment = Alignment.Center) {
        bitmap?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) } ?: Text("🎲")
    }
}

/** The dice answering as their own message: the persona's avatar and name, then the result. [provenance]: this row
 *  stands alone for its line (a hidden roll's notice), so it carries the line's pills. */
@Composable fun DiceBotRow(message: Message, model: AppViewModel, provenance: Boolean = false) {
    val bot = message.diceBot
    val tone = if (message.diceTone == DiceTone.NOTICE) diceColor(DiceTone.NEUTRAL) else diceColor(message.diceTone)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        DiceAvatar(bot, tone, model); Spacer(Modifier.width(8.dp))
        Column(Modifier.widthIn(max = 300.dp)) {
            Text(bot?.name?.ifEmpty { null } ?: tr("Dice"), style = MaterialTheme.typography.labelSmall, color = tone, fontWeight = FontWeight.SemiBold)
            // A card's hidden roll announces itself with the same "via interactive message" as the roll line.
            if (provenance && HypertextView.via(message)) { Spacer(Modifier.height(4.dp)); HypertextPills(message) }
            Spacer(Modifier.height(6.dp))
            DiceResult(message, showCommand = false)
        }
    }
}
