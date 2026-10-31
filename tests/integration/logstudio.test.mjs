import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const base = process.env.API_BASE || "http://localhost:18081";
async function call(token, method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok)
    throw Object.assign(
      Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`),
      { status: r.status },
    );
  return data;
}
const wait = async (fn) => {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error("job timeout");
};
test("Log Studio A–I: the campaign log and its exports, immutable snapshots, structured dice, TTS invalidation, privacy, three PDFs and revocable publication", async () => {
  const suffix = Math.random().toString(36).slice(2);
  const u = {};
  for (const role of ["gm", "p1", "p2"])
    u[role] = await call(null, "POST", "/api/auth/register", {
      username: role + suffix,
      password: "password",
      display_name: role,
    });
  const gm = u.gm.token,
    pl = u.p1.token,
    other = u.p2.token;
  const server = await call(gm, "POST", "/api/servers", {
    name: "Studio acceptance",
  });
  // Images are the server's own setting (there is no platform provider): use the labelled mock test patterns.
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, { image: { provider: "mock" } });
  const channel = await call(gm, "POST", `/api/servers/${server.id}/channels`, {
    name: "中文回放",
    knowledge_mode: "public",
  });
  const ch = channel.id,
    root = `/api/channels/${ch}/studio`;
  for (const role of ["p1", "p2"])
    await call(gm, "POST", `/api/channels/${ch}/members`, {
      username: role + suffix,
      role: "player",
    });
  const c1 = await call(pl, "POST", `/api/channels/${ch}/characters`, {
      name: "林调查员",
    }),
    c2 = await call(other, "POST", `/api/channels/${ch}/characters`, {
      name: "顾调查员",
    });
  const windows = await call(gm, "GET", `/api/channels/${ch}/windows`);
  const w = windows[0].id;
  const say = (token, content, extra = {}) =>
    call(token, "POST", `/api/channels/${ch}/windows/${w}/messages`, {
      content,
      ...extra,
    });
  await say(gm, "雨夜的码头，灯光已经熄灭。", { kind: "narration" });
  await say(pl, "我去检查那扇门。", { character_id: c1.id });
  await say(other, "我留在这里等你。", { character_id: c2.id });
  await say(gm, "秘密：守卫是幕后主使。", {
    visibility: "gm_only",
    kind: "narration",
  });
  const roll = await say(pl, ".ra 侦查 55", { character_id: c1.id });
  await say(pl, ".rh 1d100", { character_id: c1.id });
  // The campaign log: one per channel, synced from the chat, exported by anyone within their own view.
  const log = await call(gm, "GET", root + "/log");
  assert.equal(log.project.source_kind, "channel");
  assert.ok(log.windows.some((x) => x.id === w && x.line_count >= 5));
  assert.equal((await call(gm, "GET", root + "/log")).project.id, log.project.id, "one log per channel");
  const dl = async (token, fmt, win) => { const r = await fetch(base + root + `/log/export?format=${fmt}${win ? `&chat_window_id=${win}` : ""}`, { headers: { Authorization: `Bearer ${token}` } }); assert.ok(r.ok, `${fmt}: ${r.status}`); return r; };
  const full = await (await dl(gm, "json")).json();
  assert.equal(full.schemaVersion, "1.0"); assert.ok(full.events.some((e) => e.content.includes("幕后主使"))); assert.ok(full.meta.windows.length >= 1);
  const plJson = await (await dl(pl, "json")).json();
  assert.ok(!JSON.stringify(plJson).includes("幕后主使"), "players export only what they can read");
  assert.ok(plJson.events.some((e) => e.content.startsWith(".rh")), "the roller keeps their own hidden roll");
  const otherJson = await (await dl(other, "json")).json();
  assert.ok(!otherJson.events.some((e) => e.content.startsWith(".rh")), "nobody else gets the hidden roll");
  const sd = await (await dl(pl, "sealdice", w)).json();
  assert.equal(sd.version, 105); assert.ok(sd.items.some((i) => i.message === "我去检查那扇门。" && i.nickname === "林调查员")); assert.ok(sd.items.some((i) => i.isDice && i.message === ".ra 侦查 55"));
  await assert.rejects(dl(pl, "sealdice"), /400/);
  const zipBytes = Buffer.from(await (await dl(gm, "zip")).arrayBuffer());
  assert.equal(zipBytes.subarray(0, 4).toString("latin1"), "PK\x03\x04"); assert.ok(zipBytes.includes(Buffer.from("sealdice/")));
  const project = await call(gm, "POST", root + "/projects", {
    title: "码头记录",
  });
  await call(gm, "POST", root + `/projects/${project.id}/sync`, {});
  const events = await call(gm, "GET", root + `/projects/${project.id}/events`);
  const dice = events.find((e) => e.content === ".ra 侦查 55");
  assert.deepEqual(dice.metadata.dice_result, roll.dice);
  assert.ok(dice.dice.total !== null);
  await call(gm, "PUT", root + `/projects/${project.id}`, {
    character_map: {
      [c1.id]: { display_name: "林调查员", color: "#123456" },
      secret_alias: { display_name: "PRIVATE ALIAS" },
    },
  });
  await assert.rejects(
    call(pl, "PUT", root + "/settings", { studio_cloud_allowed: true }),
    (e) => e.status === 403,
  );
  assert.equal(
    (await call(gm, "GET", root + "/settings")).studio_cloud_allowed,
    false,
  );
  const pub = await call(
      gm,
      "POST",
      root + `/projects/${project.id}/snapshots`,
      { scope: "pl_public" },
    ),
    secret = await call(
      gm,
      "POST",
      root + `/projects/${project.id}/snapshots`,
      { scope: "gm_full" },
    );
  const snap = await call(pl, "GET", root + `/snapshots/${pub.id}`);
  assert.ok(!JSON.stringify(snap).includes("PRIVATE ALIAS"));
  assert.ok(snap.events.every((e) => e.campaign_id === ch));
  await call(gm, "PUT", root + `/projects/${project.id}`, {
    title: "Later project title",
    character_map: {
      [c1.id]: { display_name: "Later name", color: "#654321" },
    },
  });
  assert.equal(
    (await call(gm, "GET", root + `/snapshots/${pub.id}`)).character_map[c1.id]
      .color,
    "#123456",
  );
  assert.ok(!JSON.stringify(snap).includes("幕后主使"));
  assert.ok(!snap.events.some((e) => e.content.startsWith(".rh")));
  await assert.rejects(
    call(pl, "GET", root + `/snapshots/${secret.id}`),
    (e) => e.status === 403,
  );
  const first = snap.events[0];
  await call(
    gm,
    "PUT",
    root + `/projects/${project.id}/events/${first.event_id}`,
    { speaker_display_name: "CHANGED", scene_title: "CHANGED" },
  );
  assert.equal(
    (await call(gm, "GET", root + `/snapshots/${pub.id}`)).events[0]
      .speaker_display_name,
    first.speaker_display_name,
  );
  const presentation = await call(
    gm,
    "POST",
    root + `/snapshots/${pub.id}/presentations`,
    { title: "有声记录" },
  );
  for (const [c, voice] of [
    [c1, "mock-cherry"],
    [c2, "mock-ethan"],
  ])
    c.voice = await call(gm, "POST", root + "/voices", {
      name: c.name,
      character_id: c.id,
      voice_type: "preset",
      voice_id: voice,
    });
  const narrator = await call(gm, "POST", root + "/voices", {
    name: "旁白",
    voice_type: "preset",
    voice_id: "mock-serena",
  });
  const run = async (body = {}) => {
    const j = await call(
      gm,
      "POST",
      root + `/presentations/${presentation.id}/tts/jobs`,
      body,
    );
    return wait(async () => {
      const state = await call(gm, "GET", root + `/tts/jobs/${j.id}`);
      assert.notEqual(state.status, "failed", JSON.stringify(state));
      return state.status === "completed" && state;
    });
  };
  const job = await run();
  assert.ok(job.done >= 3);
  const before = await call(
    gm,
    "GET",
    root + `/presentations/${presentation.id}`,
  );
  const second = await run({ force: true });
  assert.equal(second.cached, second.done);
  await call(gm, "PUT", root + `/voices/${c1.voice.id}`, {
    voice_id: "mock-dylan",
  });
  const estimate = await call(
    gm,
    "POST",
    root + `/presentations/${presentation.id}/tts/estimate`,
    {},
  );
  assert.equal(estimate.lines, 2);
  await run();
  const after = await call(
    gm,
    "GET",
    root + `/presentations/${presentation.id}`,
  );
  for (const e of after.events) {
    const old = before.events.find((x) => x.id === e.id);
    if (e.speaker_character_id === c2.id)
      assert.equal(e.audio_asset_id, old.audio_asset_id);
    if (e.speaker_character_id === c1.id)
      assert.notEqual(e.audio_asset_id, old.audio_asset_id);
  }
  const privatePres = await call(
    gm,
    "POST",
    root + `/snapshots/${secret.id}/presentations`,
    {},
  );
  const secretLine = privatePres.events.find((e) =>
    e.content.includes("幕后主使"),
  );
  await call(gm, "PUT", root + `/pevents/${secretLine.id}`, {
    voice_profile_id: narrator.id,
  });
  const pj = await call(
    gm,
    "POST",
    root + `/presentations/${privatePres.id}/tts/jobs`,
    {},
  );
  await wait(async () => {
    const j = await call(gm, "GET", root + `/tts/jobs/${pj.id}`);
    assert.notEqual(j.status, "failed");
    return j.status === "completed";
  });
  const privateFull = await call(
    gm,
    "GET",
    root + `/presentations/${privatePres.id}`,
  );
  const audio = privateFull.events.find((e) =>
    e.content.includes("幕后主使"),
  ).audio_asset_id;
  assert.ok(audio);
  assert.equal(
    (
      await fetch(base + root + `/tts/audio/${audio}`, {
        headers: { Authorization: `Bearer ${pl}` },
      })
    ).status,
    404,
  );
  await assert.rejects(
    call(pl, "GET", root + `/tts/jobs/${pj.id}`),
    (e) => e.status === 403,
  );
  await assert.rejects(
    call(pl, "POST", root + `/snapshots/${secret.id}/pdf`, { config: {} }),
    (e) => e.status === 403,
  );
  const style = await call(gm, "POST", root + "/styles", {
    style_name: "1920调查档案",
    art_direction: "冷灰色半写实",
    period_setting: "1920年代",
    negative_constraints: "不要加入未确认的人物或线索",
  });
  await call(gm, "PUT", root + `/character-visuals/${c1.id}`, {
    description: "短黑发，灰色大衣，成年调查员",
  });
  const imageJob = await call(gm, "POST", root + "/images/jobs", {
    kind: "background",
    style_profile_id: style.id,
    prompt: "雨夜码头，仅背景",
  });
  const imageDone = await wait(async () => {
    const rows = await call(gm, "GET", root + "/images/jobs");
    const j = rows.find((x) => x.id === imageJob.id);
    assert.notEqual(j.status, "failed", JSON.stringify(j));
    return j.status === "completed" && j;
  });
  const asset = imageDone.result_asset_id;
  assert.ok(asset);
  await assert.rejects(
    call(pl, "GET", `/api/channels/${ch}/media/${asset}/meta`),
    (e) => e.status === 404,
  );
  await assert.rejects(
    call(gm, "PUT", root + `/pscenes/${presentation.scenes[0].id}`, {
      background_asset_id: asset,
    }),
    (e) => e.status === 400,
  );
  await call(gm, "PUT", `/api/channels/${ch}/media/${asset}`, {
    approval_status: "approved",
    visibility_scope: "channel",
  });
  await call(gm, "PUT", root + `/pscenes/${presentation.scenes[0].id}`, {
    background_asset_id: asset,
  });
  const unchanged = await call(gm, "GET", root + `/snapshots/${pub.id}`);
  const suggested = await call(
    gm,
    "POST",
    root + `/presentations/${presentation.id}/suggest`,
    { event_ids: [presentation.events[0].id] },
  );
  assert.equal(suggested.length, 1);
  await call(
    gm,
    "POST",
    root + `/pevents/${presentation.events[0].id}/suggestion`,
    { accept: true },
  );
  assert.deepEqual(
    (await call(gm, "GET", root + `/snapshots/${pub.id}`)).events,
    unchanged.events,
  );
  const vn = await call(gm, "POST", root + "/publications", {
    snapshot_id: pub.id,
    presentation_id: presentation.id,
    kind: "vn",
    visibility: "link",
    title: "Frozen performance",
  });
  const frozen = await call(null, "GET", `/api/published/${vn.share_token}`);
  await call(gm, "PUT", root + `/pscenes/${presentation.scenes[0].id}`, {
    title: "Updated later",
  });
  assert.deepEqual(
    (await call(null, "GET", `/api/published/${vn.share_token}`))
      .frozen_content,
    frozen.frozen_content,
  );
  assert.equal(
    (await fetch(base + `/api/published/${vn.share_token}/files/${asset}`))
      .status,
    200,
  );
  await call(gm, "POST", root + `/publications/${vn.id}/revoke`, {});
  assert.equal(
    (await fetch(base + `/api/published/${vn.share_token}/files/${asset}`))
      .status,
    404,
  );
  const docs = await call(gm, "GET", `/api/channels/${ch}/documents`);
  const secretDoc = docs.find((d) => d.gm_only);
  assert.ok(secretDoc);
  await assert.rejects(
    call(gm, "POST", root + `/snapshots/${pub.id}/pdf`, {
      config: {},
      appendix_document_ids: [secretDoc.id],
    }),
    (e) => e.status === 403 || e.status === 400,
  );
  const privatePdf = await call(gm, "POST", root + `/snapshots/${secret.id}/pdf`, {
    config: {}, appendix_document_ids: [secretDoc.id],
  });
  assert.equal(privatePdf.kp_memory, true);
  await assert.rejects(call(pl, "GET", root + `/pdf/jobs/${privatePdf.id}`), e=>e.status===403);
  await assert.rejects(call(gm, "POST", root + '/publications', {
    snapshot_id:pub.id, kind:'pdf', pdf_job_id:privatePdf.id, visibility:'link', title:'Private appendix',
  }), e=>e.status===403);
  const characterSnapshot = await call(gm, 'POST', root + `/projects/${project.id}/snapshots`, {
    scope:'character', scope_character_id:c1.id,
  });
  const playerDocs = await call(pl,'GET',`/api/channels/${ch}/documents`);
  const groupPdf = await call(pl,'POST',root + `/snapshots/${characterSnapshot.id}/pdf`, {
    config:{}, appendix_document_ids:[playerDocs[0].id],
  });
  assert.ok(groupPdf.memory_group_id);
  await assert.rejects(call(gm,'GET',root+`/pdf/jobs/${groupPdf.id}`),e=>e.status===403);
  const splitGroup = await call(gm,'POST',`/api/channels/${ch}/player-groups`,{name:'New perspective'});
  await call(gm,'PUT',`/api/channels/${ch}/player-groups/${splitGroup.id}/members/${u.p1.user.id}`,{});
  await assert.rejects(call(pl,'GET',root+`/pdf/jobs/${groupPdf.id}`),e=>e.status===403);
  const builtins = await call(gm, "GET", root + "/pdf/templates");
  for (const t of builtins.filter((t) => t.builtin)) {
    const j = await call(gm, "POST", root + `/snapshots/${pub.id}/pdf`, {
      config: t.config,
    });
    const done = await wait(async () => {
      const p = await call(gm, "GET", root + `/pdf/jobs/${j.id}`);
      assert.notEqual(p.status, "failed", JSON.stringify(p));
      return p.status === "completed" && p;
    });
    const response = await fetch(base + root + `/pdf/jobs/${done.id}/file`, {
      headers: { Authorization: `Bearer ${pl}` },
    });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    if (process.env.PDF_TEST_OUTPUT)
      await writeFile(`${process.env.PDF_TEST_OUTPUT}/${t.id}.pdf`, bytes);
  }
  const publication = await call(gm, "POST", root + "/publications", {
    snapshot_id: pub.id,
    kind: "styled",
    visibility: "link",
    title: "公开记录",
  });
  const shared = await call(
    null,
    "GET",
    `/api/published/${publication.share_token}`,
  );
  assert.ok(!JSON.stringify(shared).includes("幕后主使"));
  await call(gm, "POST", root + `/publications/${publication.id}/revoke`, {});
  await assert.rejects(
    call(null, "GET", `/api/published/${publication.share_token}`),
    (e) => e.status === 404,
  );
  assert.deepEqual(
    (await call(gm, "GET", root + `/snapshots/${pub.id}`)).events.map(
      (e) => e.content,
    ),
    snap.events.map((e) => e.content),
  );
  // Server credentials select the real provider, while the campaign policy prevents any outbound call.
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, {
    tts: {
      provider: "qwen",
      api_key: "test-only-no-outbound-key",
      api_base: "https://example.invalid",
      model: "qwen-audio-3.1-tts-plus",
    },
  });
  const qwenStatus = await call(gm, "GET", root + "/tts/status");
  assert.equal(qwenStatus.provider, "qwen");
  // Qwen's own features in the Voice Studio: design, cloning, language hints, dialects, rate/pitch/volume, pinyin.
  assert.equal(qwenStatus.features.voice_design, true); assert.equal(qwenStatus.features.voice_clone, true); assert.equal(qwenStatus.features.phoneme_dictionary, true);
  assert.deepEqual(qwenStatus.features.params.map((p) => p.key), ["rate", "pitch", "volume"]);
  assert.equal(qwenStatus.features.dialect.label, "Dialect"); assert.deepEqual(qwenStatus.features.models, []);
  const cloudVoice = await call(gm, "POST", root + "/voices", {
    name: "Policy test",
    voice_type: "preset",
    voice_id: "longanhuan_v3.1",
  });
  const usedBefore = (await call(gm, "GET", root + "/tts/usage")).used_chars;
  await assert.rejects(
    call(gm, "POST", root + "/tts/preview", {
      voice_profile_id: cloudVoice.id,
      text: "不应发送到云端。",
    }),
    (e) => e.status === 403,
  );
  assert.equal(
    (await call(gm, "GET", root + "/tts/usage")).used_chars,
    usedBefore,
  );
  await call(gm, "PUT", `/api/servers/${server.id}/settings`, {
    tts: { provider: "mock", clear_api_key: true },
  });
  console.log("validated channel", ch);
});
