package app.acerciae.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.acerciae.mobile.core.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.IdentityHashMap

// An interactive message (kind hypertext, docs/HYPERTEXT.md), drawn from its public document and this viewer's state
// as core/HypertextView.kt decides it (after the web's HypertextCard.tsx): plain text only, every card or user string
// isolated (U+2068 … U+2069, as the web's <bdi>) so it cannot turn the frame, the pill or a sentence around, colours
// from the app's theme. Everything the viewer does goes through AppViewModel to core/HypertextStore.kt. Spectators get
// the card read-only from the document alone: no status, no state, no engine.

private val Mono = SpanStyle(fontFamily = FontFamily.Monospace)

/** The row's pills: "Interactive message" on a card, "↳ via interactive message" (and who it answered) on a line a
 *  card posted. */
@OptIn(ExperimentalLayoutApi::class)
@Composable fun HypertextPills(message: Message) {
    val card = message.kind == Hypertext.KIND
    val via = HypertextView.via(message)
    if (!card && !via) return
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (card) Pill(tr(HypertextView.PILL), MaterialTheme.colorScheme.primary)
        if (via) {
            val answering = HypertextView.answering(message)
            val text = "↳ " + tr(HypertextView.VIA) + (answering?.let { " · " + Hypertext.fill(tr(HypertextView.ANSWERING), "name" to it) } ?: "")
            Pill(text, MaterialTheme.colorScheme.onSurfaceVariant, Modifier.semantics { contentDescription = tr(HypertextView.VIA_HINT) + (answering?.let { ", " + Hypertext.fill(tr(HypertextView.ANSWERING), "name" to it) } ?: "") })
        }
    }
}
@Composable private fun Pill(text: String, color: Color, modifier: Modifier = Modifier) {
    Surface(modifier, shape = RoundedCornerShape(50), color = color.copy(alpha = .14f), border = BorderStroke(1.dp, color.copy(alpha = .35f))) {
        Text(text, Modifier.padding(horizontal = 8.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall, color = color, maxLines = 2)
    }
}

/** The message's body: the card, or its plain text with a hint when this app cannot read the card. [readOnly]: a
 *  spectator's view. */
@Composable fun HypertextBody(message: Message, state: AppState, model: AppViewModel, readOnly: Boolean = false) {
    val doc = remember(message.hypertext) { Hypertext.parseDoc(message.hypertext) }
    if (doc == null) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(message.content, style = MaterialTheme.typography.bodyLarge)
            Text(tr(Hypertext.UPDATE_APP), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    HypertextCard(message, doc, state, model, readOnly || !state.online)
}

private typealias Fire = (String, HxAction) -> Unit

@OptIn(ExperimentalFoundationApi::class)
@Composable private fun HypertextCard(message: Message, doc: HxDoc, state: AppState, model: AppViewModel, spectator: Boolean) {
    // A spectator's card never reads the store: it is drawn with the document's defaults.
    val snapshot = if (spectator) null else model.hypertext.snapshot.collectAsStateWithLifecycle().value
    val card = snapshot?.cards?.get(message.id)
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val facts = HxViewerFacts(
        spectator = spectator, gm = state.gm, userId = state.user?.id, displayName = state.user?.displayName.orEmpty(),
        openWindowId = state.windowId, window = state.windows.find { it.id == message.chatWindowId }, characters = state.characters,
        speakAs = state.characterId, engine = snapshot?.engine ?: true, nowMillis = now,
    )
    val view = remember(message, doc, card, snapshot?.unavailable, facts) { HypertextView.of(message, doc, card, snapshot?.unavailable, facts) }
    // Drawn again when closes_at passes while the card is on screen.
    LaunchedEffect(view.closesInMillis) { view.closesInMillis?.let { delay(it + 50); now = System.currentTimeMillis() } }
    val resolved = remember(view.resolved) { IdentityHashMap<HxNode, HxResolved>().apply { view.resolved.forEach { put(it.node, it) } } }
    val dice = state.serverSettings.obj("features")["dice"] != JsonPrimitive(false)
    val latest by rememberUpdatedState(view)
    val fire: Fire = { node, action ->
        val v = latest
        if (!spectator && v.reason == null && !v.busy) model.hypertextAct(v.context(message.channelId ?: state.channelId, message, doc, dice), node, action)
    }
    val draw = CardDraw(doc, view, resolved, fire)
    val confirmArea = remember { BringIntoViewRequester() }
    val confirm = card?.confirm
    // A confirmation comes into view (after the frame that lays it out).
    LaunchedEffect(confirm != null) { if (confirm != null) { withFrameNanos { }; confirmArea.bringIntoView() } }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (doc.title.isNotEmpty()) Text(Hypertext.isolate(doc.title), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
        doc.body.forEachIndexed { i, n -> key(n.id ?: "#$i") { HxNodeView(n, draw) } }
        if (card != null && card.notices.isNotEmpty()) Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.primary.copy(alpha = .1f)) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp).semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                card.notices.forEach { Text(Hypertext.isolate(it), style = MaterialTheme.typography.bodyMedium) }
            }
        }
        if (confirm != null) Surface(Modifier.bringIntoViewRequester(confirmArea), shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.secondary.copy(alpha = .12f),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.secondary.copy(alpha = .4f))) {
            Column(Modifier.fillMaxWidth().padding(10.dp).semantics { contentDescription = tr(HypertextView.CONFIRM_LABEL) }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(sentence(tr(HypertextView.confirmKey(confirm)), "name" to (view.confirmName to null), "text" to (confirm.text to SpanStyle(fontWeight = FontWeight.SemiBold))), style = MaterialTheme.typography.bodyMedium)
                if (confirm.sheet) Text(tr(HypertextView.SHEET), style = MaterialTheme.typography.labelSmall, color = muted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { model.hypertextAnswer(message.id, true) }) { Text(tr(HypertextView.POST)) }
                    TextButton(onClick = { model.hypertextAnswer(message.id, false) }) { Text(tr(HypertextView.CANCEL)) }
                }
            }
        }
        card?.error?.let { Text(tr(it), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        if (view.detailsShown && card != null) ScriptDetails(card)
        if (view.footerShown) Footer(message, view, model)
    }
}

private class CardDraw(val doc: HxDoc, val view: HxCardView, val resolved: IdentityHashMap<HxNode, HxResolved>, val fire: Fire)

@OptIn(ExperimentalLayoutApi::class)
@Composable private fun HxNodeView(n: HxNode, draw: CardDraw) {
    val r = draw.resolved[n] ?: return
    if (!r.visible) return
    // off: locked (drawn disabled). wait: an action is under way; it only looks disabled, so a field keeps its focus.
    val off = draw.view.off(r)
    val wait = draw.view.waiting(r)
    when (n) {
        is HxTextNode -> Text(Hypertext.isolate(r.text.orEmpty()), style = textStyle(n.style), color = toneColor(n.tone, n.style))
        is HxDivider -> HorizontalDivider(color = Color.White.copy(alpha = .15f))
        is HxRow -> FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            n.children.forEachIndexed { i, c -> key(c.id ?: "#$i") { HxNodeView(c, draw) } }
        }
        is HxGroup -> Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.background.copy(alpha = .35f), border = BorderStroke(1.dp, Color.White.copy(alpha = .15f))) {
            Column(Modifier.fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                r.label?.let { Text(Hypertext.isolate(it), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold) }
                n.children.forEachIndexed { i, c -> key(c.id ?: "#$i") { HxNodeView(c, draw) } }
            }
        }
        is HxCheckbox -> CheckRow(Hypertext.isolate(r.label.orEmpty()), Hypertext.boolOf(r.value) == true, off, wait) { draw.fire(n.id, HxAction.Toggle) }
        is HxChoice -> ChoiceView(n, r, draw, off, wait)
        is HxInput -> InputView(n, r, draw, off, wait)
        is HxButton -> ButtonView(n, r, draw, off, wait)
    }
}

@Composable private fun textStyle(style: String): TextStyle = when (style) {
    "heading" -> MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold)
    "strong" -> MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold)
    "muted" -> MaterialTheme.typography.bodySmall
    else -> MaterialTheme.typography.bodyMedium
}
@Composable private fun toneColor(tone: String, style: String): Color = when (tone) {
    "good" -> diceColor(DiceTone.SUCCESS)
    "bad" -> MaterialTheme.colorScheme.error
    "warn" -> diceColor(DiceTone.CRITICAL)
    else -> if (style == "muted") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
}

@Composable private fun CheckRow(label: String, checked: Boolean, off: Boolean, wait: Boolean, radio: Boolean = false, change: () -> Unit) {
    val press = Modifier.let {
        if (radio) it.selectable(selected = checked, enabled = !off, role = Role.RadioButton, onClick = { if (!wait) change() })
        else it.toggleable(value = checked, enabled = !off, role = Role.Checkbox, onValueChange = { if (!wait) change() })
    }
    Row(press.alpha(if (wait) .5f else 1f).heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
        if (radio) RadioButton(selected = checked, onClick = null, enabled = !off) else Checkbox(checked = checked, onCheckedChange = null, enabled = !off)
        Spacer(Modifier.width(8.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = if (off) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
    }
}

// A choice: buttons (display buttons), a menu (display menu on an enum), else a list of radios, or of checkboxes for a
// set (also a set shown as a menu, as on the web).
@OptIn(ExperimentalLayoutApi::class)
@Composable private fun ChoiceView(n: HxChoice, r: HxResolved, draw: CardDraw, off: Boolean, wait: Boolean) {
    val options = r.options.orEmpty()
    val multi = draw.doc.state[n.bind] is HxSetDecl
    val pick = { value: String -> draw.fire(n.id, HxAction.Select(value)) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        r.label?.let { Text(Hypertext.isolate(it), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold) }
        when {
            n.display == "buttons" -> FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                options.forEach { o -> key(o.value) {
                    FilterChip(selected = o.selected, onClick = { if (!wait) pick(o.value) }, label = { Text(Hypertext.isolate(o.label)) }, enabled = !off && !o.disabled, modifier = Modifier.alpha(if (wait) .5f else 1f))
                } }
            }
            n.display == "menu" && !multi -> {
                var open by remember { mutableStateOf(false) }
                val chosen = options.firstOrNull { it.selected }
                Box {
                    OutlinedButton(onClick = { if (!wait) open = true }, enabled = !off, modifier = Modifier.alpha(if (wait) .5f else 1f)) {
                        Text(chosen?.let { Hypertext.isolate(it.label) } ?: tr(HypertextView.CHOOSE))
                    }
                    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                        options.forEach { o -> DropdownMenuItem(text = { Text(Hypertext.isolate(o.label)) }, enabled = !o.disabled, onClick = { open = false; if (!o.selected && !wait) pick(o.value) }) }
                    }
                }
            }
            else -> options.forEach { o -> key(o.value) { CheckRow(Hypertext.isolate(o.label), o.selected, off || o.disabled, wait, radio = !multi) { if (multi || !o.selected) pick(o.value) } } }
        }
    }
}

// A text input. What is typed stays here until it is committed (leaving the field: saved, no handler runs) or submitted
// (its button, or the keyboard's send action, which an IME composition never triggers: its handler runs).
@Composable private fun InputView(n: HxInput, r: HxResolved, draw: CardDraw, off: Boolean, wait: Boolean) {
    val value = Hypertext.stringOf(r.value).orEmpty()
    var draft by remember { mutableStateOf(value) }
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(value) { if (!focused) draft = value }
    val max = HypertextView.inputMax(draw.doc, n)
    val tooLong = HypertextView.tooLong(draw.doc, n, draft)
    val current by rememberUpdatedState(Triple(draft, value, off || tooLong))
    val submit = { if (!off && !wait && !tooLong) draw.fire(n.id, HxAction.Submit(draft)) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(
                value = draft, onValueChange = { if (!wait) draft = it }, enabled = !off, readOnly = wait, singleLine = true, isError = tooLong,
                label = if (r.label != null) { { Text(Hypertext.isolate(r.label)) } } else null,
                placeholder = if (n.placeholder != null) { { Text(Hypertext.isolate(n.placeholder)) } } else null,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { submit() }),
                modifier = Modifier.weight(1f).onFocusChanged { f ->
                    val (d, v, blocked) = current
                    if (focused && !f.isFocused && !blocked && d != v) draw.fire(n.id, HxAction.Commit(d))
                    focused = f.isFocused
                },
            )
            Button(onClick = submit, enabled = !off && !tooLong, modifier = Modifier.alpha(if (wait) .5f else 1f)) {
                Text(n.submitLabel?.let { Hypertext.isolate(it) } ?: tr(HypertextView.SEND))
            }
        }
        if (tooLong) Text(Hypertext.fill(tr(HypertextView.AT_MOST), "n" to max.toString()), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        Text(tr(HypertextView.SHARED), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun ButtonView(n: HxButton, r: HxResolved, draw: CardDraw, off: Boolean, wait: Boolean) {
    val click = { if (!wait) draw.fire(n.id, HxAction.Click) }
    val look = Modifier.alpha(if (wait) .5f else 1f)
    val label: @Composable RowScope.() -> Unit = { Text(Hypertext.isolate(r.label.orEmpty())) }
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        when (n.style) {
            "secondary" -> OutlinedButton(onClick = click, enabled = !off, modifier = look, content = label)
            "danger" -> Button(onClick = click, enabled = !off, modifier = look, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError), content = label)
            else -> Button(onClick = click, enabled = !off, modifier = look, content = label)
        }
        // A line the button posts is shown under it; out of character it goes out under the account's name.
        val caption = r.caption
        val key = HypertextView.captionKey(n)
        if (caption != null && key != null) Text(buildAnnotatedString { append(tr(key)); append(" "); withStyle(Mono) { append(Hypertext.isolate(caption)) } },
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// GMs: the last failure (code, message, line) and the log() lines, open when something failed.
@Composable private fun ScriptDetails(card: HxCard) {
    var open by remember(card.failure) { mutableStateOf(card.failure != null) }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        TextButton(onClick = { open = !open }, contentPadding = PaddingValues(horizontal = 4.dp)) {
            Text(tr(HypertextView.DETAILS) + " · " + tr(HypertextView.GM_ONLY), style = MaterialTheme.typography.labelMedium)
        }
        if (open) {
            card.failure?.let { f ->
                Text(buildAnnotatedString {
                    withStyle(Mono) { append(f.code) }; append(" "); append(Hypertext.isolate(f.message))
                    f.line?.let { append(" · "); append(Hypertext.fill(tr(HypertextView.LINE), "n" to it.toString())) }
                }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            card.logs.forEachIndexed { i, l -> Text("${i + 1}. " + Hypertext.isolate(l), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
        }
    }
}

@Composable private fun Footer(message: Message, view: HxCardView, model: AppViewModel) {
    val scope = rememberCoroutineScope()
    var closing by remember { mutableStateOf(false) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val small = MaterialTheme.typography.labelSmall
            view.reason?.let { Text(tr(it.text), style = small, color = muted) }
            if (view.noEngineShown) Text(tr(HypertextPipeline.NO_ENGINE), style = small, color = muted)
            if (view.working) Text(tr(HypertextView.WORKING), style = small, color = muted)
            view.usesLeft?.let { Text(Hypertext.fill(tr(HypertextView.USES_LEFT), "n" to it.toString()), style = small, color = muted) }
            if (view.spentShown) Text(tr(HypertextView.SPENT), style = small, color = muted)
        }
        if (view.closeShown) TextButton(onClick = { if (!closing) scope.launch { closing = true; try { model.hypertextClose(message) } finally { closing = false } } }, enabled = !closing,
            modifier = Modifier.semantics { contentDescription = tr(HypertextView.CLOSE) + ", " + tr(HypertextView.CLOSE_HINT) }) {
            Text(tr(HypertextView.CLOSE))
        }
    }
}

private val PLACEHOLDER = Regex("\\{(\\w+)\\}")
/** A translated sentence with its {placeholders} replaced by card or user text, each isolated and optionally styled
 *  (the web's Isolated). An unknown placeholder is left as written. */
private fun sentence(translated: String, vararg values: Pair<String, Pair<String, SpanStyle?>>): AnnotatedString {
    val map = values.toMap()
    return buildAnnotatedString {
        var at = 0
        for (m in PLACEHOLDER.findAll(translated)) {
            val (text, style) = map[m.groupValues[1]] ?: continue
            append(translated.substring(at, m.range.first))
            if (style != null) withStyle(style) { append(Hypertext.isolate(text)) } else append(Hypertext.isolate(text))
            at = m.range.last + 1
        }
        append(translated.substring(at))
    }
}
