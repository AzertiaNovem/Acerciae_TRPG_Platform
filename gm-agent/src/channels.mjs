// Which channel the client keeps. By default it never creates anything on the platform: the Keeper account is made GM
// of a channel in the web app, and the client is pointed at it (CHANNEL_ID / --channel). Without that, `setup` lists
// the channels the account already keeps and asks which one; with none, it says how to create one. Creating a server
// and a channel from the client is an explicit choice (`setup --create`), kept for scripts and tests.
import readline from "node:readline";

// Every channel the account is GM of, across its servers: [{id, name, server, serverId, knowledge_mode, rule_system}].
export async function keptChannels(api) {
  const servers = (await api.servers().catch(() => [])) ?? [];
  const out = [];
  for (const s of servers) {
    const channels = (await api.channels(s.id).catch(() => [])) ?? [];
    for (const c of channels) if (c.my_role === "gm") out.push({ id: c.id, name: c.name, server: s.name, serverId: s.id, knowledge_mode: c.knowledge_mode, rule_system: c.rule_system });
  }
  return out;
}

const describe = (c, i) => `${i + 1}. ${c.name} — server "${c.server}", ${c.knowledge_mode ?? "public"}${c.rule_system && c.rule_system !== "coc7e" ? `, ${c.rule_system}` : ""}\n     CHANNEL_ID=${c.id}`;

export function noChannelAdvice(username) {
  return [
    `${username} keeps no channel yet. The client does not create one by itself: in the web app, create a server and a channel`,
    `(or open an existing one), make ${username} its GM (channel members → role GM), then run setup again with`,
    `--channel <CHANNEL_ID> or CHANNEL_ID in .env. To let the client create a server and channel for you instead, run`,
    "`setup --create`.",
  ].join("\n");
}

export function channelListAdvice(channels) {
  return `Channels ${channels.length === 1 ? "this account keeps" : "this account keeps (pick one)"}:\n${channels.map(describe).join("\n")}\n\nPass it as --channel <CHANNEL_ID> or set CHANNEL_ID in .env.`;
}

// Asks on the terminal which of `channels` to keep; the one channel is confirmed, not assumed. Returns null when the
// user declines. `io` is for tests (a readline-like {question, close}).
export async function chooseChannel(channels, { input = process.stdin, output = process.stdout, io = null } = {}) {
  if (!channels.length) return null;
  const rl = io ?? readline.createInterface({ input, output });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  try {
    output.write(`${channelListAdvice(channels).split("\n\nPass it")[0]}\n`);
    for (;;) {
      const answer = String(await ask(channels.length === 1 ? `Keep "${channels[0].name}"? [Y/n] ` : `Which one? [1-${channels.length}, or q to stop] `)).trim().toLowerCase();
      if (channels.length === 1) { if (!answer || answer === "y" || answer === "yes") return channels[0]; if (answer === "n" || answer === "no" || answer === "q") return null; continue; }
      if (answer === "q" || answer === "quit") return null;
      const n = Number.parseInt(answer, 10);
      if (Number.isInteger(n) && n >= 1 && n <= channels.length) return channels[n - 1];
      const byId = channels.find((c) => c.id === answer);
      if (byId) return byId;
    }
  } finally { rl.close(); }
}
