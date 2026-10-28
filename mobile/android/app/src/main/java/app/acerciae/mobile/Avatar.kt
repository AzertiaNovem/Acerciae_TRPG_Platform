package app.acerciae.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.acerciae.mobile.core.*
import kotlinx.coroutines.*

private val avatarImages = LruCache<String, Bitmap>(128)
@Composable fun ProfileAvatar(name: String, state: AppState, model: AppViewModel, assetId: String = "", version: String = "", ownerId: String = "", ownerVersion: Int = 0, size: Dp = 32.dp) {
    val key = "${state.user?.id}:${state.scopeKey}:$assetId:$version:$ownerId:$ownerVersion:${state.user?.avatarVersion}"
    var bitmap by remember(key) { mutableStateOf<Bitmap?>(avatarImages.get(key)) }
    LaunchedEffect(key) {
        if (bitmap != null) return@LaunchedEffect
        try {
            val ownData = state.user?.takeIf { it.id == ownerId }?.avatarData.orEmpty()
            val bytes = when {
                assetId.isNotEmpty() -> model.bytes(listOf("channels", state.channelId, "media", assetId), version.toIntOrNull()?.takeIf { it > 0 }?.let { mapOf("v" to it.toString()) } ?: emptyMap())
                ownData.startsWith("data:image/") && ownData.contains(',') -> Base64.decode(ownData.substringAfter(','), Base64.DEFAULT)
                ownerId.isNotEmpty() && ownerVersion > 0 -> model.bytes(listOf("users", ownerId, "avatar"), mapOf("v" to ownerVersion.toString()))
                else -> return@LaunchedEffect
            }
            val decoded = withContext(Dispatchers.Default) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                val options = BitmapFactory.Options().apply { inSampleSize = 1; while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > 432) inSampleSize *= 2 }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            }
            ensureActive()
            if (decoded != null) { avatarImages.put(key, decoded); bitmap = decoded }
        } catch (e: CancellationException) { throw e } catch (_: Exception) { bitmap = null }
    }
    Box(Modifier.size(size).clip(CircleShape).background(Color(0xFF48514A)), contentAlignment = Alignment.Center) {
        bitmap?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
            ?: Text(name.take(1), style = MaterialTheme.typography.labelMedium)
    }
}
