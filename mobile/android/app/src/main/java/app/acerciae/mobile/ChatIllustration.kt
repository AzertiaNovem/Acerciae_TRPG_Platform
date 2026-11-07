package app.acerciae.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.acerciae.mobile.core.*
import kotlinx.coroutines.*

internal object ChatIllustrationImages {
    private val images = object : LruCache<String, Bitmap>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private var revision = 0
    private val removed = mutableMapOf<String, Int>()
    @Synchronized fun generation(key: String) = revision to (removed[key] ?: 0)
    @Synchronized fun get(key: String): Bitmap? = images.get(key)
    @Synchronized fun put(key: String, value: Bitmap, stamp: Pair<Int, Int>) { if (stamp == generation(key)) images.put(key, value) }
    @Synchronized fun remove(key: String) { removed[key] = (removed[key] ?: 0) + 1; images.remove(key) }
    @Synchronized fun clear() { revision++; removed.clear(); images.evictAll() }
}

@Composable fun ChatIllustration(message: Message, state: AppState, model: AppViewModel) {
    val channel = message.channelId ?: state.channelId
    val imageKey = ChatIllustrations.key(state.endpoint, state.user?.id.orEmpty(), channel, message.id)
    val unavailable = !message.hasIllustration || message.id in state.recalledMessages || state.user == null || channel != state.channelId
    val requestKey = "$imageKey|${state.scopeKey}|$unavailable"
    var bitmap by remember(requestKey) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(requestKey) { mutableStateOf(false) }
    var expanded by remember(requestKey) { mutableStateOf(false) }
    var attempt by remember(requestKey) { mutableIntStateOf(0) }
    LaunchedEffect(requestKey, attempt) {
        bitmap = null; failed = false
        if (unavailable) return@LaunchedEffect
        ChatIllustrationImages.get(imageKey)?.let { bitmap = it; return@LaunchedEffect }
        val generation = ChatIllustrationImages.generation(imageKey)
        var downloaded = false
        try {
            val bytes = model.bytes(ChatIllustrations.path(channel, message.id))
            downloaded = true
            val decoded = withContext(Dispatchers.Default) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                val options = BitmapFactory.Options().apply {
                    inSampleSize = 1
                    while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > 1920) inSampleSize *= 2
                }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: error("Invalid image")
            }
            ensureActive()
            // A recall or account/permission change may happen while the shared download finishes.
            if (generation != ChatIllustrationImages.generation(imageKey) || message.id in model.state.value.recalledMessages || state.scopeKey != model.state.value.scopeKey || state.user?.id != model.state.value.user?.id) return@LaunchedEffect
            ChatIllustrationImages.put(imageKey, decoded, generation)
            bitmap = decoded
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) {
            if (downloaded && state.scopeKey == model.state.value.scopeKey && state.user?.id == model.state.value.user?.id) model.discardMessageImage(channel, message.id)
            failed = true
        }
    }
    if (unavailable) return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val image = bitmap
        if (image != null) {
            Image(image.asImageBitmap(), tr("View illustration"), Modifier.fillMaxWidth().heightIn(max = 360.dp)
                .aspectRatio(image.width.toFloat() / image.height).clickable { expanded = true }, contentScale = ContentScale.Fit)
        } else if (failed) {
            Text(tr("The picture could not be loaded."), style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { attempt++ }) { Text(tr("Retry")) }
        } else {
            Box(Modifier.fillMaxWidth().height(100.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp)) }
        }
        if (message.illustrationCaption.isNotEmpty()) Text(message.illustrationCaption, style = MaterialTheme.typography.bodyLarge)
        if (expanded && image != null) {
            Dialog(onDismissRequest = { expanded = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
                Surface(Modifier.fillMaxSize()) {
                    Column {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { TextButton(onClick = { expanded = false }) { Text(tr("Close")) } }
                        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().clipToBounds(), contentAlignment = Alignment.Center) {
                            var scale by remember { mutableFloatStateOf(1f) }
                            var offset by remember { mutableStateOf(Offset.Zero) }
                            val width = constraints.maxWidth.toFloat(); val height = constraints.maxHeight.toFloat()
                            Image(image.asImageBitmap(), message.illustrationCaption.ifEmpty { tr("View illustration") }, Modifier.fillMaxSize()
                                .pointerInput(width, height) {
                                    detectTransformGestures { _, pan, zoom, _ ->
                                        scale = (scale * zoom).coerceIn(1f, 6f)
                                        offset = Offset((offset.x + pan.x).coerceIn(-width * (scale - 1) / 2, width * (scale - 1) / 2), (offset.y + pan.y).coerceIn(-height * (scale - 1) / 2, height * (scale - 1) / 2))
                                    }
                                }.graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y }, contentScale = ContentScale.Fit)
                        }
                    }
                }
            }
        }
    }
}
