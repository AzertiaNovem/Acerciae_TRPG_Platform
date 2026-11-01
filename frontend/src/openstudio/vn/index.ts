// Open Log Studio: the visual-novel pipeline, run locally. composeScript() plans the script (with an injected model,
// or by rules), toPresentation() feeds the in-app VNPlayer, and the bundle functions build a standalone player.
export {
  composeScript,
  // the composer's building blocks (pure, unit tested)
  blocks,
  chunk,
  parts,
  speakerLabel,
  transcript,
  mockFlat,
  mockPlan,
  fromFlat,
  normalize,
  extractJson,
  readAnswer,
  systemPrompt,
  userPrompt,
  languageName,
  SYSTEM_PROMPT,
  MOCK_NOTE,
  MAX_LINES,
  MAX_ASSET_NEEDS,
  BLOCK_GAP_SECONDS,
  PART_MAX_LINES,
  PART_MAX_CHARS,
  VN_MAX_TOKENS,
} from './compose';
export type { ComposeOptions, KnownBackground } from './compose';
export { buildInputs, planLines, assetModeOf, subtitlesOf, standeeFor, MAIN_WINDOW } from './inputs';
export type { BackgroundAsset, ScriptInputs, CastEntry, AssetEntry, PlanLine, AssetMode } from './inputs';
export { toPresentation, sanitizeTemplate, characterNames, characterImages, defaultKind, estimatedDuration } from './presentation';
export { standaloneData, standaloneHtml, bundleFiles, bundleFolderName, embedJson } from './bundle';
export type { StandaloneData, StandaloneEvent, StandaloneScene, StandaloneStage, BundleAudio, BundleFile } from './bundle';
