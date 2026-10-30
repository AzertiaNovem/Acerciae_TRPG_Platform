package app.acerciae.mobile.core

/** Client-side extension seams. No backend paths are assigned until its contracts are available. */
enum class ExportFormat { SEALDICE_JSON, CUSTOM_PDF }
data class StyleReference(val id: String, val palette: List<String>, val referenceAssetIds: List<String>)
data class ReplayAsset(val id: String, val url: String, val styleReferenceId: String, val source: AssetSource)
enum class AssetSource { UPLOADED, GENERATED }
data class VoiceAssignment(val characterId: String, val voiceId: String, val language: String = "zh-CN")
data class AudioCue(val frameId: String, val url: String, val durationMs: Long?)
data class ExportArtifact(val downloadUrl: String, val mimeType: String)
interface SpeechRepository {
    // Qwen authentication, model choice, synthesis, caching and voice authorization belong on the backend.
    suspend fun requestAudio(channelId: String, frameIds: List<String>, voices: List<VoiceAssignment>): List<AudioCue>
}
interface ExportRepository {
    suspend fun requestExport(channelId: String, sceneId: String, format: ExportFormat, templateId: String): ExportArtifact
}
interface ReplayAssetRepository {
    suspend fun assets(channelId: String, style: StyleReference): List<ReplayAsset>
}
