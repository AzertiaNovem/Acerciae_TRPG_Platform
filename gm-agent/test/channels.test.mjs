import { test } from "node:test";
import assert from "node:assert/strict";
import { channelListAdvice, chooseChannel, keptChannels, noChannelAdvice } from "../src/channels.mjs";

const api = {
  servers: async () => [{ id: "s1", name: "Arkham" }, { id: "s2", name: "Kingsport" }],
  channels: async (s) => (s === "s1"
    ? [{ id: "c1", name: "Hale house", my_role: "gm", knowledge_mode: "public", rule_system: "coc7e" }, { id: "c2", name: "Players only", my_role: "player" }]
    : [{ id: "c3", name: "The docks", my_role: "gm", knowledge_mode: "isolated", rule_system: "dnd2024" }]),
};
const io = (answers) => ({ asked: [], question(q, cb) { this.asked.push(q); cb(answers.shift() ?? "q"); }, close() {} });
const quiet = { write() {} };

test("only channels the account is GM of are offered, across its servers", async () => {
  const kept = await keptChannels(api);
  assert.deepEqual(kept.map((c) => [c.id, c.server]), [["c1", "Arkham"], ["c3", "Kingsport"]]);
  assert.match(channelListAdvice(kept), /1\. Hale house — server "Arkham", public\n\s+CHANNEL_ID=c1/);
  assert.match(channelListAdvice(kept), /2\. The docks — server "Kingsport", isolated, dnd2024/);
  assert.match(noChannelAdvice("aikeeper"), /create a server and a channel/);
  assert.match(noChannelAdvice("aikeeper"), /setup --create/);
});

test("the user picks a channel by number or id, confirms a single one, and may decline", async () => {
  const kept = await keptChannels(api);
  assert.equal((await chooseChannel(kept, { output: quiet, io: io(["x", "2"]) })).id, "c3", "a bad answer is asked again");
  assert.equal((await chooseChannel(kept, { output: quiet, io: io(["c1"]) })).id, "c1");
  assert.equal(await chooseChannel(kept, { output: quiet, io: io(["q"]) }), null);
  const one = kept.slice(0, 1);
  assert.equal((await chooseChannel(one, { output: quiet, io: io([""]) })).id, "c1", "Enter keeps the only channel");
  assert.equal(await chooseChannel(one, { output: quiet, io: io(["n"]) }), null);
  assert.equal(await chooseChannel([], { output: quiet, io: io([]) }), null);
});
