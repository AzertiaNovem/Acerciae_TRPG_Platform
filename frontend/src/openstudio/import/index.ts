// Open Log Studio importers: read chat logs (native acerciae-log 1.0/2.0, SealDice JSON and text, story-painter
// rendered logs, QQ exports) into the shared shapes of ../types, connect several logs into one project, and export.
export type { LogAdapter } from './adapter';
export { ADAPTERS, adapterByName, detectAdapter, supportedFormats, importText, importFile, scrubPlatformIds } from './registry';
export { decodeBytes, type DetectedEncoding } from './encoding';
export { isOocText, parseDice, classifyMessage, extractCqMedia, guessRole } from './classify';
export { mergeLogs, type LogFile, type MergedLog } from './merge';
export { buildProject } from './project';
export { toNativeV2, toSealDiceText, toPlainText } from './exporters';
export type {
  Visibility, LogEventWithVisibility, CharacterSheetWithBio, NativeLogV2, NativeV2Message, NativeV2Player,
  NativeV2Character, NativeV2Window, NativeV2Scenario, NativeV2Dice,
} from './nativeTypes';
