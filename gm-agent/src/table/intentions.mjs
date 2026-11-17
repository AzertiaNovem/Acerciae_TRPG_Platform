// intentions: table is the explicit runtime context supplied by Table; no service singleton.
// A co-player's standing intention (intentions.mjs), read from the file the host's Web UI edits, again only when it
// changed. Only that co-player's own prompts read it.
import { operatorPath, watchOperatorFile } from "../operator-files.mjs";
import { intentionsState } from "../intentions.mjs";

export function intentionOf(table, characterId) {
  if (!table.operatorDir || !table.roster.isCoplayer(characterId)) return "";
  table.readIntentions ??= watchOperatorFile(operatorPath(table.operatorDir, table.channelId, "intentions"), intentionsState, (m) => table.log(`intentions: ${m}`));
  return table.readIntentions().intentions[characterId]?.text ?? "";
}
