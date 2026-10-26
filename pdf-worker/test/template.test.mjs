import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../src/template.mjs";
const config = {
  base: "classic",
  page_size: "A5",
  orientation: "portrait",
  font_size: 11,
  line_height: 1.7,
  margin_mm: 18,
  character_colors: {},
  scene_images: {},
  title: "中文记录",
  toc: true,
  page_numbers: true,
  chapter_breaks: true,
};
const snapshot = {
  title: "记录",
  scope: "pl_public",
  version: 1,
  events: [
    {
      event_id: "1",
      scene_key: "dock",
      scene_title: "码头",
      speaker_display_name: "调查员",
      content: "门后传来声音。\n<script>alert(1)</script>",
      event_type: "dialogue",
    },
  ],
};
test("three print templates preserve Chinese and escape source text", () => {
  for (const base of ["classic", "dossier", "novel"]) {
    const html = renderHtml({ snapshot, config: { ...config, base } });
    assert.ok(html.includes("门后传来声音。"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("target-counter"));
  }
});
test("renderer rejects remote assets and injected page configuration", () => {
  assert.throws(() =>
    renderHtml({
      snapshot,
      config: { ...config, page_size: "A4; @import url(https://evil)" },
    }),
  );
  assert.throws(() =>
    renderHtml({
      snapshot,
      config: { ...config, cover_asset_id: "bad" },
      images: { bad: { data_uri: "https://127.0.0.1/secret" } },
    }),
  );
});

test("appendices retain source references and map frozen speaker colors", () => {
  const html = renderHtml({
    snapshot: {
      ...snapshot,
      character_map: { pc: { color: "#abcdef" } },
      events: [{ ...snapshot.events[0], speaker_key: "pc" }],
    },
    config,
    appendices: [
      {
        document_id: "timeline",
        title: "时间线",
        entries: [
          {
            summary: "确认事件",
            content: "<script>secret()</script>",
            source_event_ids: ["event-42"],
          },
        ],
      },
    ],
  });
  assert.ok(html.includes("附录 · 时间线"));
  assert.ok(html.includes("event-42"));
  assert.ok(html.includes("color:#abcdef"));
  assert.ok(!html.includes("<script>"));
});
