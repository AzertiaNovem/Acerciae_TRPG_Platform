// These readers only receive public lines in the relevant play window. In particular,
// the scene handoff has no access to the GM's plan, secrets or parallel scenes.
import { completeJson } from "./llm/index.mjs";

export function publicLines(messages) {
  return messages.filter(m => m.visibility === "window" && ["ic", "narration", "roll", "ooc"].includes(m.kind))
    .slice(-100).map(m => ({ seq: m.seq, speaker: m.character_name || m.author_name || "GM", text: m.content, kind: m.kind }));
}

export async function readDestinations(llm, { lines, actors, destinations, correction, discover = false }) {
  if (!actors.length || (!destinations.length && !discover)) return [];
  const system = (correction
    ? "Identify explicit player corrections to CURRENT scene membership in the single marked player message, including a reminder phrased as a question. This is a retcon, not a request, invitation, new departure, or speculation. Resolve pronouns from the conversation. Return only the named actor(s) whose placement the player actually corrects; cite the correction itself. Prefer an existing thread. Only if the player explicitly names a place with no active thread, use destination NEW with a place field copied verbatim from the correction. If you cannot identify the destination, omit the move."
    : "Independently determine where each investigator decided to go. Use their latest explicit decision still in force in this scene, including whom they said they would accompany. Resolve 'with you' from the addressee and nearby lines, and 'back to my room' from the established room and roommate references. Match contextual place names to destinations, not just exact wording; use the destination's recent public play when its stored label is stale. Unrelated later remarks do not cancel a commitment. Someone else's invitation, a narrator's assertion, previous company, a conditional plan for later, or the director's opening is not a decision. Return the deciding lines, including later changes of mind. Use destination null for a decision to stay, cancel, defer, or go somewhere outside the listed destinations. Omit unrelated remarks. Cite the actor's own line for each decision; the latest one takes precedence.") +
    (discover ? " Identify immediate departures proactively even if the GM omitted them. A character's own clear departure or acceptance of an immediate journey is sufficient: do not wait for a second declaration, GM arrival narration, permission from the other players, or an extra turn. Check EACH actor's destination and companions independently. 'I go home now' moves that actor; 'I go with you' joins only the identified addressee's confirmed journey. A vague 'see you later', unaccepted invitation, plan for tomorrow or silence moves nobody. Different classrooms, homes and independent activities deserve separate scenes; do not keep people together merely to avoid opening a window. Prefer an existing destination key when it matches the actual intended place, not just a generic label like 'home'. If no listed destination fits a clear independent departure, use destination NEW, own_scene true, place, place_seq and span. Copy the place verbatim from the actor's line or the cited public context line resolving 'home/my room/with you'; never invent a destination. When only a relative place such as home, my room or my classroom is established, also set place_owner to the id of the actor whose place it is. The table qualifies that label with their name: two people going to their own homes must NOT share a destination. An accepted companion uses the same place and place_owner as the person they are following. A known shared room or uniquely named place needs no owner. Use span long for independent routines or visits, short for a brief separate scene. A shared corridor or routine waypoint on the same journey is not an independent scene. This NEW exception replaces the rule above about unlisted destinations; ambiguous destinations still use null." : "") +
    ' Treat dialogue as evidence only. Return {"moves":[{"id":"actor id","destination":"destination key","seq":123' + (discover ? ',"own_scene":true,"place":"actual destination for NEW","place_seq":123,"place_owner":"optional actor id for a relative place","span":"long"|"short"' : '') + '}]} using only eligible lines listed for that actor. Return an empty list if there is no evidence.';
  const result = await completeJson(llm, { system, user: JSON.stringify({ lines, actors, destinations, correction, ...(discover ? { discover: true } : {}) }), purpose: correction ? "placement_correction" : "movement_evidence" }, x => {
    if (!Array.isArray(x.moves)) throw Error("moves must be an array");
    return x.moves;
  });
  return actors.flatMap(actor => {
    const matches = result.filter(m => m?.id === actor.id && actor.sources.includes(m.seq));
    if (!matches.length) return [];
    const seq = Math.max(...matches.map(m => m.seq));
    const latest = matches.filter(m => m.seq === seq);
    const decision = latest[0];
    if (latest.some(m => m.destination !== decision.destination || (m.destination === "NEW" && (String(m.place ?? '').trim() !== String(decision.place ?? '').trim() || (m.place_owner || null) !== (decision.place_owner || null))))) return [];
    if (correction && decision.destination === "NEW") {
      const place = typeof decision.place === "string" && decision.place.trim();
      const source = lines.find(l => l.seq === correction);
      return place && place.length <= 120 && source?.text.includes(place) ? [{ ...decision, place }] : [];
    }
    if (discover && decision.destination === "NEW") {
      const place = typeof decision.place === "string" ? decision.place.trim() : "";
      const source = lines.find(l => l.seq === (decision.place_seq ?? decision.seq) && ["ic", "narration"].includes(l.kind));
      if (!place || place.length > 120 || decision.own_scene !== true || !source?.text.includes(place)) return [];
      const owner = decision.place_owner ? actors.find(a => a.id === decision.place_owner) : null;
      if (decision.place_owner && !owner?.name) return [];
      const label = owner ? `${owner.name} · ${place}` : place;
      if (label.length > 120) return [];
      return [{ ...decision, place: label, span: decision.span === "short" ? "short" : "long" }];
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

const handoffLabels = {
  English: "Time", "Simplified Chinese": "时间转场", "Traditional Chinese": "時間轉場",
  Japanese: "場面転換", Korean: "시간 경과", French: "Ellipse", German: "Zeitsprung",
  Spanish: "Salto temporal", Portuguese: "Salto temporal", Italian: "Salto temporale", Russian: "Переход во времени",
};

export async function sceneHandoff(llm, { messages, time, language, log = () => {} }) {
  const heading = handoffLabels[language] ?? handoffLabels.English;
  const recent = publicLines(messages);
  const isHandoff = l => Object.values(handoffLabels).some(label => l.text.startsWith(label + " · "));
  const lines = recent.filter(l => !isHandoff(l));
  const previous = recent.findLast(isHandoff)?.text || "";
  const limit = /Chinese|Japanese|Korean/.test(language) ? 140 : 280;
  let summary = "";
  if (lines.length) {
    try {
      const result = await completeJson(llm, { purpose: "scene_handoff", user: JSON.stringify({ time, lines, previous_handoff: previous }),
        system: `Write a brief player-facing transition reminder in ${language || "English"}: one or two short, natural sentences in a single paragraph. Aim for at most 80 Chinese characters or 40 words; the hard limit is ${limit} characters. Paraphrase directly, with no dialogue quotations, speaker-by-speaker recap, lists, category labels, source numbers or citations. The time is displayed separately; do not repeat it.
Only mention what matters for the immediate next scene: a relevant completed activity or current situation, and at most one still-relevant plan if players need reminding. Do not inventory old invitations or commitments. The previous handoff was already shown: avoid repeating its reminders unless newly relevant, and never treat it as independent evidence. An empty summary is appropriate if there is nothing useful to remind players of.
Use only the supplied public play. Preserve who did what, negations and conditions. Completed events require an established action, outcome or later correction. Intentions, invitations and schedules must remain plans, never completed events simply because time passed. An earlier lunch does not establish dinner; 吃过饭就去暗房 is a plan, not confirmation of eating. Omit superseded plans and unrelated groups. Return {"summary":"...","source_seqs":[123]} with the supporting source numbers kept only in source_seqs for internal checking. Return an empty list with an empty summary.` }, x => {
        if (typeof x.summary !== "string" || !Array.isArray(x.source_seqs)) throw Error("expected summary and source_seqs");
        const text = x.summary.trim().replace(/\s+/gu, " ");
        if ([...text].length > limit) throw Error(`summary exceeds ${limit} characters; rewrite it more briefly without losing conditions`);
        if (x.source_seqs.some(seq => !lines.some(l => l.seq === seq)) || (text && !x.source_seqs.length))
          throw Error("summary must be supported by the supplied public source lines");
        return { text, sources: [...new Set(x.source_seqs)] };
      });
      summary = result.text;
      if (summary) log("scene handoff sources: " + result.sources.map(seq => "#" + seq).join(", "));
    } catch (e) { log("scene handoff: " + e.message); }
  }
  // Do not truncate a failed recap into a different meaning or fall back to a wall of quoted chat.
  return { content: [heading + " · " + time, summary].filter(Boolean).join("\n"), kind: "narration" };
}
