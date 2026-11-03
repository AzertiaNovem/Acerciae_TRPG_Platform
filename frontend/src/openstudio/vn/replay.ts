// Replaying the model's own turn when a script part is resumed with the user's answers (the port of the server's
// llm/Replay.cpp). A turn is stored as the provider returned it. Anthropic's thinking blocks carry a signature the API
// verifies on replay: a block is sent back only byte for byte, from the same model, with its signature; anything else
// of the turn's hidden reasoning is left out, and the text of the turn is always kept. Chat-completions providers
// have no verifiable form of their reasoning (a gateway's reasoning_content must not be sent back), so only the text
// is replayed there.
import type { LlmTurn } from '../types';

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The Anthropic content blocks to send back as the assistant turn, or null when only the plain text should be
 * replayed (another provider or model than the one that produced the turn, or nothing replayable).
 */
export function replayableBlocks(turn: LlmTurn | null | undefined, provider: string, model: string): unknown[] | null {
  if (!turn || turn.provider !== provider || provider !== 'anthropic' || !Array.isArray(turn.blocks) || !turn.blocks.length) return null;
  const sameModel = !!model && turn.model === model;
  const out: unknown[] = [];
  for (const b of turn.blocks) {
    if (!isObj(b)) continue;
    if (b.type === 'text') { if (nonEmpty(b.text)) out.push(b); }
    else if (b.type === 'thinking') { if (sameModel && nonEmpty(b.signature) && typeof b.thinking === 'string') out.push(b); }
    else if (b.type === 'redacted_thinking') { if (sameModel && nonEmpty(b.data)) out.push(b); }
    // tool_use and unknown blocks are not part of a script answer: left out.
  }
  // Only sealed reasoning without any text would be an incomplete turn: replay the plain text then.
  return out.some((b) => isObj(b) && b.type === 'text') ? out : null;
}

/** Whether a replay carries sealed reasoning (a rejected replay is then retried as plain text). */
export function carriesReasoning(blocks: unknown[] | null | undefined): boolean {
  return !!blocks?.some((b) => isObj(b) && (b.type === 'thinking' || b.type === 'redacted_thinking'));
}
