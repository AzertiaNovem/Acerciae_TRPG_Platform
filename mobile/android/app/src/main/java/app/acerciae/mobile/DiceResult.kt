package app.acerciae.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*

@Composable fun DiceResult(message: Message) {
    val emphasized = message.diceTone in listOf(DiceTone.CRITICAL, DiceTone.FUMBLE)
    val tone = when (message.diceTone) {
        DiceTone.CRITICAL, DiceTone.SUCCESS -> Color(0xFF5CC785)
        DiceTone.FUMBLE, DiceTone.FAILURE -> Color(0xFFE66E78)
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        message.diceCommand?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        Surface(color = tone.copy(alpha = if (emphasized) .16f else .08f), shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, tone.copy(alpha = if (emphasized) .9f else .4f))) {
            Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                Canvas(Modifier.padding(top = 3.dp).size(18.dp)) {
                    drawRoundRect(tone, cornerRadius = CornerRadius(3.dp.toPx()), style = Stroke(1.5.dp.toPx()))
                    listOf(.25f to .25f, .75f to .25f, .5f to .5f, .25f to .75f, .75f to .75f).forEach { (x,y) -> drawCircle(tone, 1.5.dp.toPx(), Offset(size.width*x, size.height*y)) }
                }
                Column {
                    if (message.dice?.flag("hidden") == true || message.diceTone == DiceTone.NOTICE) Text(tr("暗骰"), style = MaterialTheme.typography.labelSmall, color = tone)
                    SelectionContainer { Text(message.displayText, fontWeight = if (emphasized) FontWeight.SemiBold else FontWeight.Normal, color = if (message.diceTone == DiceTone.NOTICE) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface) }
                }
            }
        }
    }
}
