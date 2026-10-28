import Foundation

// Client extension seams only. No invented server endpoints or provider secrets.
public enum ExportFormat: Sendable { case sealdiceJSON, customPDF }
public struct VoiceAssignment: Sendable { public let characterID: String; public let voiceID: String; public let language: String }
public struct AudioCue: Sendable { public let frameID: String; public let url: URL; public let durationMS: Int? }
public struct StyleReference: Sendable { public let id: String; public let palette: [String]; public let referenceAssetIDs: [String] }
public enum AssetSource: Sendable { case uploaded, generated }
public struct ReplayAsset: Sendable { public let id: String; public let url: URL; public let styleReferenceID: String; public let source: AssetSource }
public struct ExportArtifact: Sendable { public let downloadURL: URL; public let mimeType: String }
public protocol SpeechRepository: Sendable {
    func requestAudio(channelID: String, frameIDs: [String], voices: [VoiceAssignment]) async throws -> [AudioCue]
}
public protocol ExportRepository: Sendable {
    func requestExport(channelID: String, sceneID: String, format: ExportFormat, templateID: String) async throws -> ExportArtifact
}
public protocol ReplayAssetRepository: Sendable {
    func assets(channelID: String, style: StyleReference) async throws -> [ReplayAsset]
}
