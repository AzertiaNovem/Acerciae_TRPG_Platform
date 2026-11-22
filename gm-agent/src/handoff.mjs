// Hands one of this client's characters (a former AI co-player: a PC the GM account owns) to one of the server's
// platform bots (docs/BOTS.md), so the character plays on with a bot of its own:
//   * the bot joins the channel if it is not there yet (the GM may invite whatever the channel's switch says);
//   * the character becomes the bot's; the platform has the bot take the part up with one line in character;
//   * the bot sits, with the character, in every window the character sat in;
//   * what the character remembered of the campaign (this client's memory chapters of it, oldest first), with its
//     persona and standing intention, becomes the bot's private briefing at this table.
// Nothing here needs the model, and the table may be running meanwhile.

const BRIEFING_BYTES = 8000;
const norm = (s) => String(s ?? "").normalize("NFKC").trim().toLowerCase();
const bytes = (s) => Buffer.byteLength(s);

// The briefing: who the character is, its aim, and the newest of its memories that fit (whole chapters, oldest first).
export function handoffBriefing({ name, persona = "", intention = "", chapters = [] }) {
  const head = [
    `You now play ${name} at this table. Until now the GM's AI played ${name}; carry on as the same person.`,
    persona ? `WHO ${name.toUpperCase()} IS:\n${persona}` : "",
    intention ? `${name.toUpperCase()}'S STANDING AIM: ${intention}` : "",
  ].filter(Boolean).join("\n\n");
  const title = `WHAT ${name.toUpperCase()} REMEMBERS OF THE CAMPAIGN (oldest first):`;
  const kept = [];
  let size = bytes(head) + bytes(title) + 4;
  for (const c of [...chapters].reverse()) {
    const text = `[#${c.fromSeq}–#${c.toSeq}] ${String(c.text ?? "").trim()}`;
    if (size + bytes(text) + 2 > BRIEFING_BYTES) break;
    kept.unshift(text); size += bytes(text) + 2;
  }
  let out = kept.length ? `${head}\n\n${title}\n${kept.join("\n\n")}` : head;
  while (bytes(out) > BRIEFING_BYTES) out = out.slice(0, Math.floor(out.length * 0.95));
  return out;
}

// `state`: this client's saved state of the channel (its roster's seats, when it has them); `chapters(characterId)`:
// the character's memory chapters; `intentionOf(characterId)`: its standing intention. Returns what was done.
export async function handoffToBot(api, { channelId, characterName, botName, state = null, chapters = () => [], intentionOf = () => "", log = () => {} }) {
  const channel = await api.channel(channelId);
  if (channel.my_role !== "gm") throw new Error("this account is not the GM of the channel");
  const me = await api.me();
  const characters = await api.characters(channelId);
  const character = characters.find((c) => norm(c.name) === norm(characterName));
  if (!character) throw new Error(`no character "${characterName}" in this channel`);
  if (character.kind !== "pc" || character.user_id !== me.id) throw new Error(`${character.name} is not one of this account's characters`);
  const bots = await api.get(`/api/servers/${channel.server_id}/bots`);
  const bot = bots.find((b) => norm(b.name) === norm(botName));
  if (!bot) throw new Error(`no bot "${botName}" on this server (Server settings → Bots)`);
  if (!bot.enabled) throw new Error(`${bot.name} is switched off`);
  if (characters.some((c) => c.kind === "pc" && c.user_id === bot.user_id)) throw new Error(`${bot.name} already plays a character in this channel`);
  const view = await api.get(`/api/channels/${channelId}/bots`);
  if (!(view.present ?? []).some((b) => b.id === bot.id)) {
    await api.post(`/api/channels/${channelId}/bots`, { bot_id: bot.id });
    log(`${bot.name} joined the channel`);
  }
  // The windows the character sits in: its open seats in this client's roster, else the windows it is bound to.
  const seated = (state?.coplayers ?? []).find((c) => c.characterId === character.id);
  const windows = await api.windows(channelId);
  const open = seated ? [...new Set(seated.seats.filter((s) => s.toSeq === null).map((s) => s.windowId))]
    : windows.filter((w) => (w.members ?? []).some((m) => m.character_id === character.id)).map((w) => w.id);
  await api.transferCharacter(channelId, character.id, { user_id: bot.user_id, expected_user_id: me.id });
  for (const w of open) {
    const win = windows.find((x) => x.id === w);
    if (!win || win.archived_at) continue;
    if ((win.members ?? []).some((m) => m.user_id === bot.user_id && m.character_id === character.id)) continue;
    await api.addWindowMember(channelId, w, { user_id: bot.user_id, character_id: character.id }).catch((e) => log(`window ${win.name}: ${e.message}`));
  }
  const briefing = handoffBriefing({ name: character.name, persona: seated?.persona || character.bio || "", intention: intentionOf(character.id), chapters: chapters(character.id) });
  await api.put(`/api/channels/${channelId}/bots/${bot.id}/briefing`, { text: briefing });
  return { character: character.name, bot: bot.name, windows: open.length, briefingBytes: bytes(briefing), chapters: chapters(character.id).length };
}
