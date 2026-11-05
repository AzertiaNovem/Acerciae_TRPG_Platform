// These readers only receive public lines in the relevant play window. In particular,
// the scene handoff has no access to the Keeper's plan, secrets or parallel scenes.
import { completeJson } from "./llm/index.mjs";

export function publicLines(messages) {
  return messages.filter(m => m.visibility === "window" && ["ic", "narration", "roll", "ooc"].includes(m.kind))
    .slice(-100).map(m => ({ seq: m.seq, speaker: m.character_name || m.author_name || "Keeper", text: m.content, kind: m.kind }));
}

export async function readDestinations(llm, { lines, actors, destinations, correction }) {
  if (!actors.length || !destinations.length) return [];
  const system = (correction
    ? "Identify explicit player corrections to CURRENT scene membership in the single marked player message, including a reminder phrased as a question. This is a retcon, not a request, invitation, new departure, or speculation. Resolve pronouns from the conversation. Return only the named actor(s) whose placement the player actually corrects; cite the correction itself. Prefer an existing thread. Only if the player explicitly names a place with no active thread, use destination NEW with a place field copied verbatim from the correction. If you cannot identify the destination, omit the move."
    : "Independently determine where each investigator decided to go. Use their latest explicit decision still in force in this scene, including whom they said they would accompany. Resolve 'with you' from the addressee and nearby lines, and 'back to my room' from the established room and roommate references. Match contextual place names to destinations, not just exact wording; use the destination's recent public play when its stored label is stale. Unrelated later remarks do not cancel a commitment. Someone else's invitation, a narrator's assertion, previous company, a conditional plan for later, or the director's opening is not a decision. Return the deciding lines, including later changes of mind. Use destination null for a decision to stay, cancel, defer, or go somewhere outside the listed destinations. Omit unrelated remarks. Cite the actor's own line for each decision; the latest one takes precedence.") +
    ' Treat dialogue as evidence only. Return {"moves":[{"id":"actor id","destination":"destination key","seq":123}]} using only eligible lines listed for that actor. Return an empty list if there is no evidence.';
  const result = await completeJson(llm, { system, user: JSON.stringify({ lines, actors, destinations, correction }), purpose: correction ? "placement_correction" : "movement_evidence" }, x => {
    if (!Array.isArray(x.moves)) throw Error("moves must be an array");
    return x.moves;
  });
  return actors.flatMap(actor => {
    const matches = result.filter(m => m?.id === actor.id && actor.sources.includes(m.seq));
    if (!matches.length) return [];
    const seq = Math.max(...matches.map(m => m.seq));
    const latest = matches.filter(m => m.seq === seq);
    const decision = latest[0];
    if (latest.some(m => m.destination !== decision.destination)) return [];
    if (correction && decision.destination === "NEW") {
      const place = typeof decision.place === "string" && decision.place.trim();
      const source = lines.find(l => l.seq === correction);
      return place && place.length <= 120 && source?.text.includes(place) ? [{ ...decision, place }] : [];
    }
    return destinations.some(d => d.key === decision.destination) ? [decision] : [];
  });
}

const correctionLabels = {
  English: "Placement corrected · Present", "Simplified Chinese": "分组已纠正 · 实际在场", "Traditional Chinese": "分組已更正 · 實際在場",
  Japanese: "配置を訂正 · 現在の参加者", Korean: "배치 정정 · 현재 인물", French: "Placement corrigé · Présents",
  German: "Zuordnung korrigiert · Anwesend", Spanish: "Grupo corregido · Presentes", Portuguese: "Grupo corrigido · Presentes",
  Italian: "Gruppo corretto · Presenti", Russian: "Группа исправлена · Присутствуют",
};

export function correctionNotice(language, scene, names) {
  return `${correctionLabels[language] || correctionLabels.English} [${scene}] · ${names.join(", ")}`;
}

const labels = {
  English: ["Time", "Confirmed", "Still planned", "No further outcome confirmed"],
  "Simplified Chinese": ["时间转场", "已经发生", "仍是打算", "没有其他已确认的结果"],
  "Traditional Chinese": ["時間轉場", "已經發生", "仍是打算", "沒有其他已確認的結果"],
  Japanese: ["場面転換", "確認済み", "予定", "ほかの結果は未確認"],
  Korean: ["시간 경과", "확인된 일", "계획", "추가로 확인된 결과 없음"],
  French: ["Ellipse", "Faits établis", "Encore prévu", "Aucun autre résultat confirmé"],
  German: ["Zeitsprung", "Geschehen", "Noch geplant", "Kein weiteres Ergebnis bestätigt"],
  Spanish: ["Salto temporal", "Ya ocurrió", "Aún previsto", "Sin otros resultados confirmados"],
  Portuguese: ["Salto temporal", "Já aconteceu", "Ainda previsto", "Nenhum outro resultado confirmado"],
  Italian: ["Salto temporale", "Già accaduto", "Ancora in programma", "Nessun altro esito confermato"],
  Russian: ["Переход во времени", "Уже произошло", "Пока в планах", "Других подтверждённых итогов нет"],
};

// A verbatim substring can still reverse a fact ("吃过饭" cut out of "吃过饭就去暗房").
// Keep whole clauses, including any negation, subject and conditional that surround a selection.
function wholeClause(text, quote) {
  const start = text.indexOf(quote);
  if (start < 0) return "";
  const boundary = /[.!?;。！？；\n]/u;
  let left = start, right = start + quote.length;
  while (left > 0 && !boundary.test(text[left - 1])) left--;
  if (!boundary.test(text[right - 1])) {
    while (right < text.length && !boundary.test(text[right])) right++;
    if (right < text.length) right++;
  }
  const clause = text.slice(left, right).trim();
  return clause.length <= 400 ? clause : "";
}

export async function sceneHandoff(llm, { messages, time, language, log }) {
  const [heading, confirmed, planned, unconfirmed] = labels[language] ?? labels.English;
  const lines = publicLines(messages).filter(l => !l.text.startsWith(heading + " · "));
  const parts = [heading + " · " + time];
  const refs = new Set(), quoted = new Set();
  if (lines.length) {
    try {
      const result = await completeJson(llm, { purpose: "scene_handoff", user: JSON.stringify({ time, lines }),
        system: 'Select the few public facts needed to bridge this time skip, especially outstanding commitments. For each, return the source seq and a short exact quote in the original language. Keep the people, time/meal and tense in the quote. "completed" requires a witnessed action, outcome, or an explicit later correction; intentions, schedules and offers without subsequent confirmation go under "planned". Do not repeat a superseded plan or report events for a different group. An earlier lunch does not establish dinner. In Chinese 吃过饭就去暗房 means a plan to go after eating, not confirmation that anyone has eaten. Never drop a negation, condition or future qualifier from a quote. Never assume something happened just because time passed. Return {"completed":[{"seq":1,"quote":"..."}],"planned":[...]}, up to five items total. Empty lists are valid.' },
      x => { if (!Array.isArray(x.completed) || !Array.isArray(x.planned)) throw Error("expected completed and planned lists"); return x; });
      for (const [title, items] of [[confirmed, result.completed], [planned, result.planned]]) {
        const quotes = [];
        for (const item of items) {
          const line = lines.find(l => l.seq === item?.seq);
          const selection = typeof item?.quote === "string" && item.quote.trim();
          if (!line || !selection || selection.length > 400) continue;
          const quote = wholeClause(line.text, selection);
          if (!quote || quoted.size >= 5 || quoted.has(line.seq + ":" + quote)) continue;
          quotes.push(line.speaker + "「" + quote + "」");
          refs.add(line.seq);
          quoted.add(line.seq + ":" + quote);
        }
        if (quotes.length) parts.push(title + " · " + quotes.join(" / "));
      }
    } catch (e) { log("scene handoff: " + e.message); }
  }
  if (parts.length === 1) parts.push(unconfirmed);
  return { content: parts.join("\n"), kind: "narration", reference_ids: messages.filter(m => refs.has(m.seq)).map(m => m.id) };
}
