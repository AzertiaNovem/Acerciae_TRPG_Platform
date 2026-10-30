package app.acerciae.mobile

import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import app.acerciae.mobile.core.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable fun AtmosphereBackdrop(state: AppState, model: AppViewModel) {
    if (!state.online || state.channelId.isEmpty() || state.user?.atmosphereEnabled != true || !state.serverSettings.obj("features").flag("atmosphere")) return
    val portrait = LocalConfiguration.current.orientation != Configuration.ORIENTATION_LANDSCAPE
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    key(state.user?.id, state.scopeKey, dark, portrait) {
        var bitmap by remember { mutableStateOf<Bitmap?>(null) }
        var loadedAsset by remember { mutableStateOf("") }; var mock by remember { mutableStateOf(false) }
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(lifecycle) {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (isActive) {
                    try {
                        val current = model.get(listOf("channels", state.channelId, "atmosphere"))
                        val id = Atmosphere.asset(current, dark, portrait)
                        if (id == null) { bitmap = null; loadedAsset = "" }
                        else {
                            if (id != loadedAsset) {
                                val bytes = model.bytes(listOf("channels", state.channelId, "atmosphere", "assets", id))
                                val decoded = withContext(Dispatchers.Default) {
                                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                                    val opts = BitmapFactory.Options().apply { inSampleSize = 1; while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > 1920) inSampleSize *= 2 }
                                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
                                }
                                ensureActive(); bitmap = decoded; loadedAsset = if (decoded == null) "" else id
                            }
                            mock = current.flag("mock")
                        }
                    } catch (e: CancellationException) { throw e } catch (_: Exception) { bitmap = null; loadedAsset = "" }
                    delay(30000)
                }
            }
        }
        Box(Modifier.fillMaxSize().clearAndSetSemantics { }) {
            bitmap?.let {
                Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alpha = 0.26f)
                if (mock) Surface(Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(horizontal = 24.dp, vertical = 8.dp), shape = MaterialTheme.shapes.small) { Text(tr("Mock background"), Modifier.padding(6.dp), style = MaterialTheme.typography.labelSmall) }
            }
        }
    }
}
@Composable fun AtmosphereHistory(state: AppState, model: AppViewModel, close: () -> Unit) {
    if (!state.gm) { Text(tr("仅当前频道的 GM 可访问")); return }
    var history by remember(state.scopeKey) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var error by remember { mutableStateOf("") }; var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    suspend fun load() {
        if (loading) return
        loading = true; error = ""
        try { history = model.rows(listOf("channels", state.channelId, "atmosphere", "history")) }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { history = emptyList(); error = tr("Something went wrong in this view.") }
        finally { loading = false }
    }
    LaunchedEffect(state.scopeKey) { load() }
    LazyColumn(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { TextButton(onClick = close) { Text(tr("Back")) }; Text(tr("Atmosphere background history"), style = MaterialTheme.typography.titleLarge) }
        item { TextButton(onClick = { scope.launch { load() } }, enabled = !loading) { Text(tr("Refresh")) }; if (loading) LinearProgressIndicator(); if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error) }
        items(history, key = { it.id }) { item ->
            var expanded by remember(item.id) { mutableStateOf(false) }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { expanded = !expanded }) { Text(item.text("scene_label") + " · " + item.text("created_at")) }
                if (expanded) {
                    Text(item.text("reason")); Text(item.text("mood"))
                    Atmosphere.variants.forEach { variant ->
                        val job = item.rows("variants").find { it.text("variant") == variant }
                        Text(tr(atmosphereLabel(variant)) + " · " + tr(job?.text("status") ?: "pending"), style = MaterialTheme.typography.titleSmall)
                        androidx.compose.foundation.text.selection.SelectionContainer { Text(item.obj("prompts").text(variant)) }
                        if (!job?.text("error").isNullOrEmpty()) Text(job!!.text("error"), color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }
}
private fun atmosphereLabel(variant: String) = mapOf("day_landscape" to "Landscape · light theme", "night_landscape" to "Landscape · dark theme", "day_portrait" to "Portrait · light theme", "night_portrait" to "Portrait · dark theme")[variant] ?: variant
