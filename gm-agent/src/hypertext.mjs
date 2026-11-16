// Interactive messages (docs/HYPERTEXT.md): the cards this client posts. Every card is built here, by code, from
// declarative parts only: text, a choice, checkboxes and buttons whose `act` the apps run natively. The model never
// writes a card or its JavaScript (no builder ever produces `script`); it only asks for a roll, and code picks the
// builder and fills it. Whatever text comes from the model is cleaned and cut by code points to the card format v1
// rules, so a builder never produces a card the platform refuses (400 invalid_hypertext); a builder that cannot make a
// valid card returns null and the caller posts its plain line instead.
import { languageName } from "./table/shared.mjs";

// Card format v1 limits (code points unless noted), as the platform checks them (backend/src/chat/Hypertext.cpp).
export const LIMITS = { title: 120, text: 2000, label: 120, button: 60, value: 64, content: 2000, say: 500, sayLines: 5, nodes: 64, stateKeys: 32, options: 20, actors: 10, items: 30, leaves: 8 };
const ID = /^[a-z][a-z0-9_]{0,31}$/;
// Lowercase Object.prototype member names: never ids (the apps look ids up in plain objects).
const RESERVED = new Set(["constructor", "prototype", "__proto__", "tostring", "valueof", "hasownproperty", "isprototypeof", "propertyisenumerable", "tolocalestring", "__definegetter__", "__definesetter__", "__lookupgetter__", "__lookupsetter__"]);
export const validId = (s) => typeof s === "string" && ID.test(s) && !RESERVED.has(s);

// ---- text
export const cpLength = (s) => [...String(s)].length;

// Whether a code point may appear in card text: no C0 controls (a line break only in multi-line text), no bidi
// embeddings, overrides or isolates, no lone surrogates or noncharacters. Also refused here, though the platform lets
// them through: DEL and the C1 controls (U+0085 would start a line inside a label).
function allowed(cp, multiline) {
  if (cp < 0x20) return multiline && cp === 0x0a;
  if (cp >= 0x7f && cp <= 0x9f) return false;
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  return !((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe);
}

// `s` cut to at most `max` code points, ending in "…" when something was cut.
export function clip(s, max) {
  const cps = [...String(s ?? "")];
  return cps.length <= max ? cps.join("") : `${cps.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

// Text from anywhere (the model, a character's name) as a card may carry it: refused characters dropped, tabs and
// (in a one-line field) line breaks made spaces, "{{" broken up (it would open a placeholder), trimmed and cut.
// "" when nothing is left.
export function cleanText(value, { max = LIMITS.label, multiline = false } = {}) {
  let s = String(value ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  if (!multiline) s = s.replace(/[\n\u0085\u2028\u2029]+/g, " ");
  s = [...s].filter((ch) => allowed(ch.codePointAt(0), multiline)).join("");
  s = s.replace(/\{(?=\{)/g, "{ ");
  s = multiline ? s.split("\n").map((l) => l.replace(/ {2,}/g, " ").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n") : s.replace(/ {2,}/g, " ");
  return clip(s.trim(), max).trim();
}

// ---- dice commands: a port of dice::parseCommand and hypertext::diceVerdict (the platform re-checks every line)
const LITERALS = [["move", "move"], ["init", "init"], ["rah", "ra"], ["rch", "ra"], ["ra", "ra"], ["rc", "ra"], ["rih", "ri"], ["ri", "ri"], ["rh", "r"], ["r", "r"],
  ["sc", "sc"], ["st", "st"], ["en", "en"], ["ds", "ds"], ["ss", "ss"]];
const asciiTrim = (s) => String(s ?? "").replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
const asciiLower = (c) => (c >= 0x41 && c <= 0x5a ? c + 32 : c);

export function parseCommand(content) {
  let s = asciiTrim(content);
  if (s.startsWith("。") || s.startsWith("．")) s = `.${s.slice(1)}`;
  if (s.length < 2 || s[0] !== ".") return null;
  const rest = s.slice(1);
  for (const [lit, name] of LITERALS) {
    if (rest.length < lit.length || [...lit].some((c, i) => asciiLower(rest.charCodeAt(i)) !== c.charCodeAt(0))) continue;
    if (rest.length > lit.length) {
      const c = rest[lit.length], code = rest.charCodeAt(lit.length);
      const ok = " \t\n\v\f\r".includes(c) || (code >= 0x30 && code <= 0x39) || code >= 0x80 || "(%#+-/".includes(c) || (lit === "r" && (c === "d" || c === "D"));
      if (!ok) continue;
    }
    return { name, args: asciiTrim(rest.slice(lit.length)), raw: `.${lit}`, hidden: ["rah", "rch", "rh", "rih"].includes(lit) };
  }
  return null;
}

// ri/rih only with modifiers (+2, - 1, +1d4, +d6, adv, dis), each ending at a space, a sign or the end: a name could
// overwrite someone else's initiative. A port of hypertext::modifiersOnly.
function modifiersOnly(args) {
  const n = args.length, at = (k) => args.charCodeAt(k);
  const space = (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d), digit = (c) => c >= 0x30 && c <= 0x39, alpha = (c) => (c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a;
  const boundary = (k) => k >= n || space(at(k)) || at(k) === 0x2b || at(k) === 0x2d;
  let i = 0;
  for (;;) {
    while (i < n && space(at(i))) i++;
    if (i >= n) return true;
    if (at(i) === 0x2b || at(i) === 0x2d) {
      i++; while (i < n && space(at(i))) i++;
      const a = i; while (i < n && digit(at(i))) i++;
      const count = i > a;
      if (i < n && (at(i) | 0x20) === 0x64) {
        const b = ++i; while (i < n && digit(at(i))) i++;
        if (i === b) return false;
      } else if (!count) return false;
      if (!boundary(i)) return false;
    } else {
      const a = i; while (i < n && alpha(at(i))) i++;
      const w = args.slice(a, i).toLowerCase();
      if (!["adv", "advantage", "dis", "disadvantage"].includes(w) || !boundary(i)) return false;
    }
  }
}

// allowed: r, ra, ri with modifiers; confirm: sc, ds (the viewer's app asks first); refused: any other command;
// none: not a command.
export function diceVerdict(text) {
  const cmd = parseCommand(text);
  if (!cmd) return "none";
  if (cmd.name === "r" || cmd.name === "ra") return "allowed";
  if (cmd.name === "ri") return modifiersOnly(cmd.args) ? "allowed" : "refused";
  if (cmd.name === "sc" || cmd.name === "ds") return "confirm";
  return "refused";
}

// What a roll asks for, for telling whether a typed roll answers a card: the command's canonical name (ra for
// .ra/.rc/.rah/.rch, r for .r/.rh) and its words, lowercased, without the numbers (a skill value, a modifier).
// `.ra Spot Hidden`, `.rc spot hidden 60` and `。rah Spot Hidden +10` are the same roll; null when not a command.
export function rollSignature(text) {
  const cmd = parseCommand(text);
  if (!cmd) return null;
  const words = cmd.args.toLowerCase().split(/\s+/).map((w) => w.replace(/[+-]\d+%?$/, "")).filter((w) => w && !/^[+-]?\d+%?$/.test(w));
  return [cmd.name, ...words].join(" ");
}

// A command a card may post as the clicker, one line: null when it cannot be (another command, more than one line,
// a "{{", refused characters).
function cardCommand(command) {
  const say = asciiTrim(command);
  if (!say || /[\n\u0085\u2028\u2029]/.test(say) || say.includes("{{") || cpLength(say) > LIMITS.say) return null;
  if ([...say].some((ch) => !allowed(ch.codePointAt(0), false))) return null;
  return ["allowed", "confirm"].includes(diceVerdict(say)) ? say : null;
}

// `content`: the plain text everyone else sees (search, the AI, logs, older apps): never empty, never a dot command.
function fallbackContent(text) {
  const s = cleanText(text, { multiline: true, max: LIMITS.content });
  if (!s) return undefined;
  return parseCommand(s) ? clip(`→ ${s}`, LIMITS.content) : s;
}

const uniqueIds = (ids) => [...new Set((Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === "string" && id))].slice(0, LIMITS.actors);
const uniqueLabels = (xs, max) => {
  const out = [];
  for (const x of Array.isArray(xs) ? xs : []) {
    const label = cleanText(typeof x === "string" ? x : x?.label ?? x?.text, { max });
    if (label && !out.some((y) => y.toLowerCase() === label.toLowerCase())) out.push(label);
  }
  return out;
};

// ---- strings, by the table's language (Table.language: the 11 names of daily-locale.mjs, or a code); English for
// any other language.
const STRINGS = {
  English: {
    rollTitle: (name) => (name ? `Roll for ${name}` : "Roll request"), check: (what) => `Roll ${what}`, roll: "Roll", initiative: "Roll initiative",
    sanity: (args) => (args ? `Sanity check ${args}` : "Sanity check"), deathSave: "Death saving throw",
    choiceTitle: "Your choice", choose: "Choose", chose: "I choose: {{pick}}", checklistTitle: "Checklist", allDone: "All done.",
  },
  "Simplified Chinese": {
    rollTitle: (name) => (name ? `${name} 的检定` : "检定请求"), check: (what) => `检定：${what}`, roll: "掷骰", initiative: "投先攻",
    sanity: (args) => (args ? `理智检定 ${args}` : "理智检定"), deathSave: "死亡豁免检定",
    choiceTitle: "请选择", choose: "确定", chose: "我选择：{{pick}}", checklistTitle: "清单", allDone: "全部完成。",
  },
  "Traditional Chinese": {
    rollTitle: (name) => (name ? `${name} 的檢定` : "檢定請求"), check: (what) => `檢定：${what}`, roll: "擲骰", initiative: "擲先攻",
    sanity: (args) => (args ? `理智檢定 ${args}` : "理智檢定"), deathSave: "死亡豁免檢定",
    choiceTitle: "請選擇", choose: "確定", chose: "我選擇：{{pick}}", checklistTitle: "清單", allDone: "全部完成。",
  },
  Japanese: {
    rollTitle: (name) => (name ? `${name}の判定` : "判定リクエスト"), check: (what) => `判定：${what}`, roll: "ダイスを振る", initiative: "イニシアチブを振る",
    sanity: (args) => (args ? `正気度ロール ${args}` : "正気度ロール"), deathSave: "死亡セーヴィング・スロー",
    choiceTitle: "選んでください", choose: "決定", chose: "私の選択：{{pick}}", checklistTitle: "チェックリスト", allDone: "すべて完了。",
  },
  Korean: {
    rollTitle: (name) => (name ? `${name}의 판정` : "판정 요청"), check: (what) => `판정: ${what}`, roll: "굴리기", initiative: "우선권 굴리기",
    sanity: (args) => (args ? `이성 판정 ${args}` : "이성 판정"), deathSave: "죽음 내성 굴림",
    choiceTitle: "선택하세요", choose: "선택", chose: "내 선택: {{pick}}", checklistTitle: "체크리스트", allDone: "모두 완료했습니다.",
  },
  Spanish: {
    rollTitle: (name) => (name ? `Tirada para ${name}` : "Petición de tirada"), check: (what) => `Tirar ${what}`, roll: "Tirar", initiative: "Tirar iniciativa",
    sanity: (args) => (args ? `Tirada de cordura ${args}` : "Tirada de cordura"), deathSave: "Tirada de salvación contra muerte",
    choiceTitle: "Tu elección", choose: "Elegir", chose: "Elijo: {{pick}}", checklistTitle: "Lista de comprobación", allDone: "Todo listo.",
  },
  French: {
    rollTitle: (name) => (name ? `Jet pour ${name}` : "Demande de jet"), check: (what) => `Lancer ${what}`, roll: "Lancer", initiative: "Lancer l’initiative",
    sanity: (args) => (args ? `Test de santé mentale ${args}` : "Test de santé mentale"), deathSave: "Jet de sauvegarde contre la mort",
    choiceTitle: "Votre choix", choose: "Choisir", chose: "Je choisis : {{pick}}", checklistTitle: "Liste de contrôle", allDone: "Tout est fait.",
  },
  German: {
    rollTitle: (name) => (name ? `Wurf für ${name}` : "Wurfanfrage"), check: (what) => `Würfeln: ${what}`, roll: "Würfeln", initiative: "Initiative würfeln",
    sanity: (args) => (args ? `Stabilitätswurf ${args}` : "Stabilitätswurf"), deathSave: "Todesrettungswurf",
    choiceTitle: "Deine Wahl", choose: "Wählen", chose: "Ich wähle: {{pick}}", checklistTitle: "Checkliste", allDone: "Alles erledigt.",
  },
  Russian: {
    rollTitle: (name) => (name ? `Бросок для ${name}` : "Запрос броска"), check: (what) => `Бросок: ${what}`, roll: "Бросить", initiative: "Бросить инициативу",
    sanity: (args) => (args ? `Проверка рассудка ${args}` : "Проверка рассудка"), deathSave: "Спасбросок от смерти",
    choiceTitle: "Ваш выбор", choose: "Выбрать", chose: "Я выбираю: {{pick}}", checklistTitle: "Чек-лист", allDone: "Всё готово.",
  },
  Portuguese: {
    rollTitle: (name) => (name ? `Rolagem para ${name}` : "Pedido de rolagem"), check: (what) => `Rolar ${what}`, roll: "Rolar", initiative: "Rolar iniciativa",
    sanity: (args) => (args ? `Teste de sanidade ${args}` : "Teste de sanidade"), deathSave: "Teste de resistência contra a morte",
    choiceTitle: "Sua escolha", choose: "Escolher", chose: "Eu escolho: {{pick}}", checklistTitle: "Lista de verificação", allDone: "Tudo pronto.",
  },
  Italian: {
    rollTitle: (name) => (name ? `Tiro per ${name}` : "Richiesta di tiro"), check: (what) => `Tira ${what}`, roll: "Tira", initiative: "Tira l’iniziativa",
    sanity: (args) => (args ? `Prova di sanità mentale ${args}` : "Prova di sanità mentale"), deathSave: "Tiro salvezza contro la morte",
    choiceTitle: "La tua scelta", choose: "Scegli", chose: "Scelgo: {{pick}}", checklistTitle: "Lista di controllo", allDone: "Tutto fatto.",
  },
};
export function cardStrings(language) {
  const s = String(language ?? "").trim();
  if (STRINGS[s]) return STRINGS[s];
  if (/^zh[-_](hant|tw|hk|mo)\b/i.test(s) || /traditional chinese/i.test(s)) return STRINGS["Traditional Chinese"];
  return STRINGS[languageName(s)] ?? (/^zh\b|chinese/i.test(s) ? STRINGS["Simplified Chinese"] : STRINGS.English);
}

// The roll button's label: the skill or expression the command asks for, in the table's language.
function rollLabel(L, say) {
  const cmd = parseCommand(say);
  const args = cleanText(cmd.args, { max: LIMITS.button });
  const label = cmd.name === "ri" ? L.initiative : cmd.name === "ds" ? L.deathSave : cmd.name === "sc" ? L.sanity(args) : args ? L.check(args) : L.roll;
  return cleanText(label, { max: LIMITS.button }) || L.roll;
}

// ---- builders. Each returns the body for POST /channels/{c}/windows/{w}/hypertext, or null.

// A one-tap roll for one player character: the narration, then a button that posts `command` as the player's own
// roll (their character, their sheet) and greys itself out. `content` is the line posted today without cards
// ("<text>\n→ <name>: <command>"), which every reader that does not render cards sees instead.
export function rollRequest({ text = "", command, pcId, name = "", language, content } = {}) {
  const say = cardCommand(command);
  if (!say || typeof pcId !== "string" || !pcId) return null;
  const L = cardStrings(language);
  const narration = cleanText(text, { multiline: true, max: LIMITS.text });
  const who = cleanText(name, { max: 80 });
  const body = {
    content: fallbackContent(content ?? `${narration ? `${narration}\n` : ""}→ ${who ? `${who}: ` : ""}${say}`),
    hypertext: {
      v: 1,
      title: cleanText(L.rollTitle(who), { max: LIMITS.title }),
      state: { done: { type: "bool" } },
      body: [
        ...(narration ? [{ type: "text", text: narration }] : []),
        { type: "button", id: "roll", label: rollLabel(L, say), act: { say, set: { done: true } }, enable_if: { key: "done", eq: false } },
      ],
      actors: [pcId],
      runs_per_viewer: 1,
    },
  };
  return checked(body);
}

// A pick among 2–20 options: each reader picks (privately) and presses the button, which posts "I choose: <option>"
// as their own line (out of character unless `kind` is "ic"), once. `actorIds`: who may answer (everyone when empty).
export function choice({ prompt = "", options = [], actorIds = [], language, title, kind = "ooc", content } = {}) {
  const labels = uniqueLabels(options, LIMITS.label).slice(0, LIMITS.options);
  if (labels.length < 2) return null;
  const L = cardStrings(language);
  const ask = cleanText(prompt, { multiline: true, max: LIMITS.text });
  const actors = uniqueIds(actorIds);
  const open = { key: "done", eq: false };
  const body = {
    content: fallbackContent(content ?? [ask, labels.join(" / ")].filter(Boolean).join("\n")),
    hypertext: {
      v: 1,
      title: cleanText(title, { max: LIMITS.title }) || L.choiceTitle,
      state: { pick: { type: "enum", values: labels.map((label, i) => ({ value: `o${i + 1}`, label })) }, done: { type: "bool" } },
      body: [
        ...(ask ? [{ type: "text", text: ask }] : []),
        { type: "choice", id: "options", bind: "pick", display: labels.length <= 5 ? "buttons" : "list", enable_if: open },
        { type: "button", id: "choose", label: L.choose, act: { say: L.chose, say_kind: kind === "ic" ? "ic" : "ooc", set: { done: true } },
          enable_if: { all: [open, { not: { key: "pick", empty: true } }] } },
      ],
      ...(actors.length ? { actors } : {}),
      runs_per_viewer: 1,
    },
  };
  return checked(body);
}

// A list of up to 30 things to tick: each reader ticks their own copy (saved for them, on all their devices); nothing
// is posted. Up to 8 items, "All done." shows once every box is ticked. Without `content` the platform writes the
// fallback ("<title>\n☐ item …").
export function checklist({ title, items = [], language, actorIds = [] } = {}) {
  const list = uniqueLabels(items, LIMITS.label).slice(0, LIMITS.items);
  if (!list.length) return null;
  const L = cardStrings(language);
  const actors = uniqueIds(actorIds);
  const keys = list.map((_, i) => `i${i + 1}`);
  const done = keys.map((key) => ({ key, eq: true }));
  const body = {
    hypertext: {
      v: 1,
      title: cleanText(title, { max: LIMITS.title }) || L.checklistTitle,
      state: Object.fromEntries(keys.map((key) => [key, { type: "bool" }])),
      body: [
        ...list.map((label, i) => ({ type: "checkbox", id: `c${i + 1}`, label, bind: keys[i] })),
        ...(list.length <= LIMITS.leaves ? [{ type: "text", text: L.allDone, tone: "good", show_if: done.length === 1 ? done[0] : { all: done } }] : []),
      ],
      ...(actors.length ? { actors } : {}),
    },
  };
  return checked(body);
}

// ---- a check of what the builders make against the card format v1 rules they rely on (ids, lengths, counts,
// nesting, conditions, placeholders, the say). Not the platform's whole validator: a card that passes is one these
// builders could have made. Returns the problems as "path: message".
export function cardProblems(body) {
  const out = [], ht = body?.hypertext, ids = new Set();
  const fail = (p, m) => out.push(`${p}: ${m}`);
  const str = (v, p, max, multiline = false) => {
    if (typeof v !== "string" || !v.trim()) return fail(p, "must be a non-empty string");
    if ([...v].some((ch) => !allowed(ch.codePointAt(0), multiline))) fail(p, "holds a refused character");
    if (cpLength(v) > max) fail(p, `must be at most ${max} code points`);
  };
  if (!ht || ht.v !== 1) return ["hypertext.v: must be 1"];
  if ("script" in ht) fail("hypertext.script", "builders never write scripts");
  if (body.content !== undefined) { str(body.content, "content", LIMITS.content, true); if (parseCommand(body.content)) fail("content", "must not be a dot command"); }
  if (ht.title !== undefined) str(ht.title, "hypertext.title", LIMITS.title);
  const state = ht.state ?? {};
  if (Object.keys(state).length > LIMITS.stateKeys) fail("hypertext.state", `at most ${LIMITS.stateKeys} keys`);
  for (const [k, d] of Object.entries(state)) {
    if (!validId(k)) fail(`hypertext.state.${k}`, "invalid id");
    if (d.type === "enum") {
      if (!(d.values?.length >= 2 && d.values.length <= LIMITS.options)) fail(`hypertext.state.${k}.values`, "2 to 20 values");
      d.values?.forEach((v, i) => { str(v.value, `hypertext.state.${k}.values[${i}].value`, LIMITS.value); str(v.label, `hypertext.state.${k}.values[${i}].label`, LIMITS.label); });
    } else if (d.type !== "bool") fail(`hypertext.state.${k}`, "builders use bool and enum keys");
  }
  const placeholders = (s, p) => {
    for (const m of String(s).matchAll(/\{\{([a-z0-9_]*)\}\}|\{\{/g)) {
      const key = m[1];
      if (!key || !state[key] || state[key].type === "bool") fail(p, `"{{" must open a placeholder of a declared int, enum, set or text key`);
    }
  };
  let nodes = 0;
  const cond = (c, p, depth = 1, count = { leaves: 0 }) => {
    if (depth > 3) return fail(p, "conditions nest at most 3 deep");
    if (c.all || c.any) { const xs = c.all ?? c.any; if (!(xs.length >= 1 && xs.length <= 8)) fail(p, "1 to 8 conditions"); xs.forEach((x, i) => cond(x, `${p}[${i}]`, depth + 1, count)); }
    else if (c.not) cond(c.not, `${p}.not`, depth + 1, count);
    else { if (++count.leaves > LIMITS.leaves) fail(p, `at most ${LIMITS.leaves} leaves`); if (!state[c.key]) fail(p, "not a declared state key"); }
  };
  const walk = (list, p, level) => {
    if (!Array.isArray(list) || !list.length) return fail(p, "at least one node");
    list.forEach((n, i) => {
      const np = `${p}[${i}]`;
      if (++nodes > LIMITS.nodes) return;
      if (n.id !== undefined) { if (!validId(n.id)) fail(`${np}.id`, "invalid id"); else if (ids.has(n.id)) fail(`${np}.id`, "duplicate id"); else ids.add(n.id); }
      if (n.show_if) cond(n.show_if, `${np}.show_if`);
      if (n.enable_if) cond(n.enable_if, `${np}.enable_if`);
      if (["checkbox", "choice", "input", "button"].includes(n.type) && n.id === undefined) fail(`${np}.id`, "required");
      if (n.type === "text") { str(n.text, `${np}.text`, LIMITS.text, true); placeholders(n.text, `${np}.text`); }
      else if (n.type === "checkbox") { str(n.label, `${np}.label`, LIMITS.label); placeholders(n.label, `${np}.label`); if (state[n.bind]?.type !== "bool") fail(`${np}.bind`, "a bool key"); }
      else if (n.type === "choice") { if (n.label !== undefined) str(n.label, `${np}.label`, LIMITS.label); if (!["enum", "set"].includes(state[n.bind]?.type)) fail(`${np}.bind`, "an enum or set key"); }
      else if (n.type === "button") {
        str(n.label, `${np}.label`, LIMITS.button); placeholders(n.label, `${np}.label`);
        if ("on" in n || !n.act) fail(np, "builders' buttons carry act only");
        if (n.act?.say !== undefined) {
          const say = n.act.say, ap = `${np}.act.say`;
          str(say, ap, LIMITS.say, true); placeholders(say, ap);
          if (say.split(/[\n\u0085\u2028\u2029]/).length > LIMITS.sayLines) fail(ap, `at most ${LIMITS.sayLines} lines`);
          if (diceVerdict(say) === "refused") fail(ap, "a command a card may not post");
        }
        for (const [k, v] of Object.entries(n.act?.set ?? {})) if (!state[k] || (state[k].type === "bool" && typeof v !== "boolean")) fail(`${np}.act.set.${k}`, "a declared key and value");
      } else if (n.type === "group" || n.type === "row") { if (level >= (n.type === "group" ? 1 : 2)) fail(`${np}.type`, "nested too deep"); walk(n.children, `${np}.children`, n.type === "row" ? 2 : 1); }
      else if (n.type !== "divider") fail(`${np}.type`, "unknown node type");
    });
  };
  walk(ht.body, "hypertext.body", 0);
  if (nodes > LIMITS.nodes) fail("hypertext.body", `at most ${LIMITS.nodes} nodes`);
  if (ht.actors !== undefined && !(Array.isArray(ht.actors) && ht.actors.length >= 1 && ht.actors.length <= LIMITS.actors)) fail("hypertext.actors", "1 to 10 character ids");
  return out;
}

// A builder's card, or null (and so the plain line) should it ever break a rule.
function checked(body) {
  if (body.content === undefined) delete body.content;
  return cardProblems(body).length ? null : body;
}
