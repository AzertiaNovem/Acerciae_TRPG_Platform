# Interactive messages: a guide for bot authors

An **interactive message** (a *card*; `messages.kind = "hypertext"`) is a chat message a channel's GM account posts
through the API. It carries a small declarative UI — text, checkboxes, choices, text inputs, buttons, rows and groups —
and, optionally, a short JavaScript script. Every reader sees the card in the chat; when a reader uses it, their app
updates *their own* copy of the card's state and may post:

- **one line as the reader** (a `say`): their own words or a dice roll, with their character and permissions, exactly
  as if they had typed it — so `.ra Spot Hidden` is a real roll by their investigator;
- **one of your lines** (a `reply`): text you declared privately when you posted the card, posted as you.

That is all a card can do. There is no event channel back to your bot: you learn what happened from the lines that get
posted, like everyone else at the table. The route reference is in [API.md](API.md#interactive-messages).

The server side (posting, state, actions, limits, the fallback text) is complete. Rendering cards and running their
scripts is the apps' job; sections marked **(apps)** describe behaviour shipped in the web, desktop, Android and iOS
apps (and **(gm-agent)** what gm-agent does with cards); until an app ships it, that app shows the card's plain-text
fallback.

## Quick start

A GM account's token (a bot account the GM added as a channel GM works the same):

```sh
API=https://your.server/api
TOKEN=$(curl -s $API/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"keeper-bot","password":"…"}' | jq -r .token)
CH=<channel id>; WIN=<chat window id>; ADA=<Ada's character id>
```

Ask Ada's player for a Spot Hidden roll with one tap:

```sh
curl -s $API/channels/$CH/windows/$WIN/hypertext -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "content": "The study is dark and smells of old paper.\n→ Ada: .ra Spot Hidden",
  "hypertext": {
    "v": 1,
    "title": "Spot Hidden",
    "state": { "done": { "type": "bool" } },
    "body": [
      { "type": "text", "text": "The study is dark and smells of old paper." },
      { "type": "button", "id": "roll", "label": "Roll Spot Hidden",
        "act": { "say": ".ra Spot Hidden", "set": { "done": true } },
        "enable_if": { "key": "done", "eq": false } }
    ],
    "actors": ["'"$ADA"'"],
    "runs_per_viewer": 1
  }
}'
```

The response is the posted message. When Ada's player taps the button, their app posts `.ra Spot Hidden` as Ada; the
roll arrives on your WebSocket as a normal `message.posted` whose message has `via_hypertext_id` equal to your card's
id and `via_user_id` the player. Close the card once you have what you wanted:

```sh
curl -s -X POST $API/channels/$CH/messages/<card id>/hypertext/close -H "Authorization: Bearer $TOKEN"
```

**(gm-agent)** gm-agent builds its cards in code, from declarative parts only, with the builders of
[`gm-agent/src/hypertext.mjs`](../gm-agent/src/hypertext.mjs) (`rollRequest`, `choice`, `checklist`; no builder ever
produces a `script`). Today only its `request_roll` action posts a card: a roll card like the one above for a character
a person plays, closed once the roll arrives (see "Interactive messages: roll cards" in
[gm-agent/README.md](../gm-agent/README.md#interactive-messages-roll-cards)). The agent's model only asks for the roll;
`choice` and `checklist` are for your own code that posts cards:

```js
// Inside gm-agent (`api` is its client, src/api.mjs).
import { rollRequest } from "./src/hypertext.mjs";
const body = rollRequest({ text: "Something glints under the desk.", command: ".ra Spot Hidden", pcId: adaId, name: "Ada", language: "en" });
if (body) await api.postHypertext(channelId, windowId, body);   // null: no valid card, post the plain line instead
```

## The post body

| field | | |
|---|---|---|
| `content` | optional | The plain text everyone else sees (search, the AI, logs, exports, older apps): 1–2000 code points, not starting with a dot command. Without it the server builds the [fallback](#the-fallback-text). |
| `character_id` | optional | The card speaks as this character: an NPC, your own PC, or a PC with no player. Another player's PC is refused (403). |
| `visibility`, `whisper_to` | optional | `window` (default), `gm_only`, or `whisper` with a list of character ids, as for a GM's chat line. Every line the card produces stays inside this audience or a narrower one. |
| `closes_in` | optional | Seconds until the card closes by itself: 60 to 2592000 (30 days); default 604800 (7 days). |
| `hypertext` | required | The card, [format v1](#card-format-v1). |
| `replies` | optional | Up to 16 private reply templates, `{id: Reply}` ([replies](#replies-your-lines-said-by-your-card)). |

At most 20 cards a minute per author and channel (429 `rate_limited` with `retry_after`).

## Card format v1

```jsonc
{
  "v": 1,                          // the only version the server accepts
  "title": "…",                    // optional, ≤120 code points, shown above the body (never interpolated)
  "state": { "<key>": StateDecl }, // optional, ≤32 keys
  "body": [ Node ],                // required, at least one node
  "script": "…",                   // optional, ≤16 KiB of UTF-8 (apps)
  "actors": ["<character id>"],    // optional, 1–10 characters of the channel; leave it out to let every reader act
  "runs_per_viewer": 1             // optional, 1–100 (default 1): actions with effects each viewer may take
}
```

Unknown keys anywhere are errors. A rejected card answers 400 `invalid_hypertext` with up to 10 errors, each with its
path in your post body, for example:

```json
{"error": "invalid_hypertext", "message": "hypertext.body[0].colour: unknown key",
 "errors": [{"path": "hypertext.body[0].colour", "message": "unknown key"},
            {"path": "hypertext.body[1]", "message": "a button needs exactly one of on or act"}]}
```

Ids (node ids, state keys, reply ids, slot names, handler names, groups) match `^[a-z][a-z0-9_]{0,31}$` and are not
JavaScript prototype names (`constructor`, `valueof`, `tostring`, `hasownproperty`, …). Node ids are unique in a card.

### State

Each viewer has their own copy of the card's state, starting from the defaults. It is saved on the server for that
viewer only; neither you nor any other GM can read it (see [security](#the-security-model-in-plain-words)).

| type | fields | default | interpolated as |
|---|---|---|---|
| `bool` | – | `false` | (not interpolatable) |
| `int` | `min`, `max` within ±1e9; `default` | `default`, else `min` | the decimal number |
| `enum` | `values: [{value ≤64, label? ≤120}]`, 2–20 unique; `default` | `default`, else `null` | the label (`""` when null) |
| `set` | `values` as for enum; `max` 1–20 (default: all) | `[]` | the labels in declaration order, joined with `", "` |
| `text` | `max` 1–500 (default 500) | `""` | the text as typed (one line) |

A label defaults to its value. A viewer's serialized state is at most 8 KiB.

### Nodes

At most 64 nodes, nested `body > group > row > leaf`: groups sit only in the body, rows hold only leaves. Any node may
have `show_if`; controls may have `enable_if`.

| type | fields |
|---|---|
| `text` | `text` ≤2000 code points (line breaks allowed, interpolated); `style`: `body` (default), `muted`, `heading`, `strong`; `tone`: `neutral` (default), `good`, `bad`, `warn` |
| `checkbox` | `id`, `label` ≤120 (interpolated), `bind` (a bool key), `on`? |
| `choice` | `id`, `label`? ≤120 (interpolated), `bind` (an enum or set key), `display`: `list` (default), `buttons`, `menu` (enum only), `options`? (a subset of the key's values, in display order), `on`? |
| `input` | `id`, `label`? ≤120 (interpolated), `placeholder`? ≤120, `bind` (a text key), `submit_label`? ≤40, `on`? |
| `button` | `id`, `label` ≤60 (interpolated), `style`: `primary` (default), `secondary`, `danger`; exactly one of `on` (a script handler) and `act` (declarative) |
| `row`, `group` | `children` (at least one); a group has an optional `title` ≤80 (interpolated) |
| `divider` | – |

**Interpolation.** `{{key}}` in text nodes, control labels, group titles and `act.say` is replaced by the viewer's
current value (as the state table shows). The key must be a declared int, enum, set or text key, checked when you post,
so a literal `{{` is never valid and nothing needs escaping. The card title, placeholders, submit labels and value
labels are shown as written.

**Conditions** (`show_if`, `enable_if`):

- leaves: `{key, eq}` (bool, enum — `null` included —, int, text), `{key, in: [...]}` (enum, int; 1–20 values),
  `{key, has}` (set), `{key, gte}` / `{key, lte}` (int), `{key, empty: true|false}` (text, set, enum);
- combinators: `{all: [...]}`, `{any: [...]}` (1–8 each), `{not: c}`;
- at most 3 levels deep counting the leaf (`all > any > leaf` is the deepest), at most 8 leaves per condition. Types are
  checked when you post.

**Declarative act** (no script needed; works on every app that renders cards):
`{"set": {key: value}?, "say": "text with {{key}}"?, "say_kind": "ic"|"ooc"?, "reply": "<reply id>"?}`. In that order:
`set` changes the viewer's state, then `say` is interpolated from the new state and posted as the viewer, then `reply`
is asked for with each of its slots filled from the state key of the same name (whose values must all fit the slot:
enum values a subset of the slot's, an int range inside the slot's). `say` is checked when you post: at most 500 code
points and 5 lines, and if it is a dice command, one a card may post (see the [dice policy](#the-dice-policy)). Apps
show a declarative `say` as a caption under its button, so the viewer sees what will be posted in their name.

**When controls are disabled.** Apps disable every control while the card's status is loading, when the card is closed
or recalled, when the viewer is not one of its `actors`, for a spectator or the demo, when the card sits in a forked
window's history (it belongs to another window), when the window is archived, and when the viewer is paused there. The
server enforces the same rules.

### Text rules

Lengths count Unicode code points. Strings may not contain C0 control characters (a line break is allowed in text
nodes, reply templates, says and `content`), bidi embeddings, overrides or isolates (U+202A–U+202E, U+2066–U+2069),
noncharacters, lone surrogates or invalid UTF-8. Apps render card text as plain text only: no HTML, Markdown, links or
images, and every run is bidi-isolated, so a card cannot imitate the chat frame, the sender or the "Interactive message"
label around it. Cards never cause a network request: there are no URL, image or style fields.

### Replies: your lines, said by your card

```jsonc
"replies": {
  "door": { "text": "The door groans open onto a cold stair.", "kind": "narration", "audience": "card", "total": 1 },
  "clue": { "text": "Behind the portrait: a key stamped {{mark}}.", "audience": "viewer", "group": "portrait",
            "slots": { "mark": { "type": "enum", "values": ["13", "31"] } } },
  "bid":  { "text": "{{amount}} guineas, says the auctioneer.", "kind": "ic", "character_id": "<NPC id>",
            "slots": { "amount": { "type": "int", "min": 10, "max": 500 } }, "per_viewer": 20 },
  "dmg":  { "text": ".r {{n}}d6 falling masonry", "slots": { "n": { "type": "int", "min": 1, "max": 4 } } }
}
```

| field | | |
|---|---|---|
| `text` | required | ≤1000 code points (line breaks allowed); `{{slot}}` placeholders must be declared slots, and the longest possible rendering must fit 2000 code points. A template that is itself a `.r`/`.rh` roll rolls dice when it is posted; any other leading dot command is refused when you post. |
| `kind` | `narration` (default), `ic`, `ooc` | |
| `character_id` | optional | An NPC, your own PC or a PC with no player. If it later leaves the channel or gains another player, the reply is posted without a character. |
| `audience` | `card` (default), `viewer`, `gm` | `card`: the card's audience; `viewer`: a whisper to the viewer's character (GM-only when a GM asks; a player with no character gets 400 `no_character`); `gm`: GM-only. |
| `slots` | optional, ≤4 | `{name: {type: "enum", values: [1–20 strings ≤64, no line breaks]}}` or `{name: {type: "int", min, max}}` within ±1e9. |
| `per_viewer` | 1–20, default 1 | How often each viewer may get it. |
| `total` | 1–1000, default unlimited | How often it may be posted on the card at all. |
| `group` | optional id | At most one reply of the group per viewer: mutually exclusive answers. |

A viewer's app sends only the reply's id and slot values. The server takes the text, kind, character and audience from
your stored template, accepts only declared enum strings and integers in range for the slots, and posts the line as
you, labelled "via {viewer}". There is no slot for the viewer's name or any free text: a reply can never say something
you did not write. A reply's slot value can never turn it into a dice command: whether a reply rolls is decided by its
template when you post the card. Replies stop when you are no longer a GM of the channel or your account is suspended
(409 `sender_unavailable`).

### Limits

| | |
|---|---|
| the normalized card, script included | 32 KiB of JSON |
| the stored card (with the reply stubs, which repeat every enum slot's values) / the reply templates | 60 KiB of JSON each, as the database stores it (400 `invalid_hypertext` at `replies`) |
| script | 16 KiB |
| nodes / state keys / replies / slots / actors | 64 / 32 / 16 / 4 per reply / 10 |
| a viewer's state | 8 KiB |
| `content` / text node / reply template | 2000 / 2000 / 1000 code points |
| `say` | 1–500 code points after trimming, at most 5 lines (`\n`, U+0085, U+2028 and U+2029 each start a line) |
| cards | 20 a minute per author and channel |
| actions | `runs_per_viewer` per viewer; 10 a minute per viewer and card, 30 per viewer and channel; 60 replies a minute per card |
| state saves | 120 a minute per viewer |

## The fallback text

Without `content`, the server writes the card's plain text itself, the same way every time and with no locale words:
the title, then one line per node visible under the default state.

| element | line |
|---|---|
| title | the title |
| text | the text, interpolated with the defaults |
| checkbox | `☐ label` |
| choice | `label: A / B / C` (its options' labels) |
| input | `label: ____` |
| button | `[label]` |
| group | its title |
| divider | `—` |

The lines are joined with line breaks and cut to 2000 code points (`—` when nothing is visible). The roll request above
without its `content` would read `Spot Hidden\nThe study is dark and smells of old paper.\n[Roll Spot Hidden]`. Write
your own `content` when the card's meaning should survive for the AI and the log — for a roll request, today's text
"→ Ada: .ra Spot Hidden" is better than a button label. Text hidden under the default state never reaches the fallback.

## The dice policy

A `say` that is a dice command is posted as the viewer's own command, by its canonical name:

| | commands |
|---|---|
| run directly | `.r` / `.rh`; `.ra` / `.rc` / `.rah` / `.rch`; `.ri` / `.rih` with modifiers only (`+2`, `-1`, `+1d4`, `adv`, `dis`) |
| need the viewer's confirmation | `.sc`, `.ds`: they change the viewer's sheet. Apps ask first; the server answers 428 `confirmation_required` until the request says `confirmed: true`. |
| refused | `.ri` with a name (it could overwrite another character's initiative), `.st`, `.en`, `.ss`, `.init`, `.move` |

`.ri` / `.rih` also need a card whose visibility is `window`: the initiative order is the whole window's, so a GM-only or
whisper card cannot add to it (403 `hypertext_command_not_allowed`).

A hidden roll (`.rh`, `.rah`) sends its result to the viewer's character when that character is inside the card's
audience, and its notice to the card's audience. With the server's dice turned off, a say posts as plain text, and a
say that looks like a dice command needs the viewer's confirmation like any free text: the server answers 428
`confirmation_required` with `sheet: false` until the request says `confirmed: true`. Rolls
from cards cannot be recalled, like any roll; other lines follow the normal 2-minute recall.

## What a viewer's app does

1. Renders the card natively from the document and the viewer's state (`GET /channels/{c}/hypertext?ids=` for every
   loaded card); no JavaScript runs to render.
2. On a control without a handler or `act` (a checkbox, a choice, an input's submit): applies the change and saves it
   (`PUT …/hypertext/state`, debounced).
3. On a declarative `act`: computes the new state and the effects, then `POST …/hypertext/act` (or a PUT when nothing
   is posted).
4. On an `on` handler **(apps)**: runs your script for that one event (below), shows the new state, asks the viewer to
   confirm any free-text `say` or sheet change, then acts.

An action request is `{interaction_id, node, say?, reply?, state?, base_version}`. The app makes a new UUID per action
and reuses it when it retries, so a retry never posts twice; it sends the state version it acted on, and the server
refuses the action (409 `state_conflict`) when the viewer's state changed on another device meanwhile. A retry of an
action that finished replays its result even after you closed the card (a bot that closes a card as soon as its line
arrives does not break the viewer's retry). The response lists each line posted, re-read for the viewer: a line the
viewer may not read — your GM-only reply, the result of a hidden-roll reply — is `null` for them. Error codes are
listed in [API.md](API.md#interactive-messages).

You can drive the same route by hand to test a card:

```sh
curl -s $API/channels/$CH/messages/$CARD/hypertext/act -H "Authorization: Bearer $PLAYER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"interaction_id":"'"$(uuidgen)"'","node":"roll","say":{"text":".ra Spot Hidden"},"state":{"done":true},"base_version":0}'
```

## The security model in plain words

- **The card is public to its readers.** The document, the script, the reply stubs (ids, slot names and values,
  audience, group) and every state declaration are sent to everyone who can read the card, and kept in the apps'
  caches. Do not put spoilers there. Spoilers belong only in reply templates, which never leave the server: not in the
  message, its events, exports, caches, the campaign log or any response.
- **Scripts are UI, not referees.** A modified app can ask for any of your declared replies, with any declared slot
  values, within their limits, and can post any line the viewer could type. So never let a script decide a secret or a
  success: decide it in your bot (from the lines that arrive) or with a server dice roll. Use `group` and `total` for
  mutually exclusive outcomes. The worst a forged app can achieve is: you say one of your own lines, with values you
  listed, within your limits, to the audience you chose, labelled "via {player}".
- **Each viewer's state is theirs.** No route lets a GM or a bot read it. It can still reach you, but only through lines
  the viewer's actions post — including replies whose slot values a script fills from the state — so treat anything a
  viewer types into a card as something they may share. Apps say so under every input ("Anything you type here may be
  shared in the chat."). The platform's operator holds the stored states; they are deleted with the card (recall) or the
  channel.
- **Lines stay inside the card's audience.** A say goes to the card's audience; a reply to the card's, the viewer's or
  the GMs'; a hidden roll's notice to the card's. Whisper cards therefore let their readers answer privately, up to
  `runs_per_viewer` lines each: you grant that by posting one.
- **Nothing runs unless the viewer acts.** Scripts run on the viewer's own gesture, on their own device, one event at a
  time; free text posted in their name needs their confirmation (apps), and sheet changes need it on the server too.
- **Cards are labelled.** Every card shows its sender and an "Interactive message" label it cannot hide, and every line
  a card produced shows "via interactive message". The operator can turn the feature off (`HYPERTEXT_ENABLED=false`).

## Examples

### A roll request

The quick-start card. `actors` limits it to Ada; `enable_if` greys the button out once used on every device of that
player; `runs_per_viewer: 1` makes the server refuse a second roll (409 `runs_exhausted`). Close it when the roll
arrives, or when you ask for a different roll.

### A choice

```json
{
  "content": "Where now? The lighthouse, the harbour or back to the inn.",
  "hypertext": {
    "v": 1, "title": "Where now?",
    "state": {
      "pick": { "type": "enum", "values": [ { "value": "lighthouse", "label": "the lighthouse" },
                                            { "value": "harbour", "label": "the harbour" },
                                            { "value": "inn", "label": "the inn" } ] },
      "done": { "type": "bool" }
    },
    "body": [
      { "type": "choice", "id": "where", "label": "Where do you go?", "bind": "pick", "display": "buttons",
        "enable_if": { "key": "done", "eq": false } },
      { "type": "button", "id": "go", "label": "Go", "act": { "say": "I head for {{pick}}.", "set": { "done": true } },
        "enable_if": { "all": [ { "key": "done", "eq": false }, { "not": { "key": "pick", "empty": true } } ] } }
    ]
  }
}
```

Each player's pick is private until they press Go; then "I head for the harbour." is posted as their character.

### A checklist

```json
{
  "hypertext": {
    "v": 1, "title": "Before you descend",
    "state": { "lamp": { "type": "bool" }, "rope": { "type": "bool" }, "map": { "type": "bool" } },
    "body": [
      { "type": "checkbox", "id": "c_lamp", "label": "Lamp oil", "bind": "lamp" },
      { "type": "checkbox", "id": "c_rope", "label": "Rope", "bind": "rope" },
      { "type": "checkbox", "id": "c_map", "label": "The surveyor's map", "bind": "map" },
      { "type": "text", "text": "Ready to descend.", "tone": "good",
        "show_if": { "all": [ { "key": "lamp", "eq": true }, { "key": "rope", "eq": true }, { "key": "map", "eq": true } ] } }
    ]
  }
}
```

Nothing is posted: each player ticks their own list, saved on the server and shown on all their devices.

### A vote counted from lines

```json
{
  "content": "Vote: who leads the expedition? Ada, Bea or Cy.",
  "hypertext": {
    "v": 1, "title": "Who leads?",
    "state": { "who": { "type": "enum", "values": [ { "value": "ada", "label": "Ada" }, { "value": "bea", "label": "Bea" },
                                                    { "value": "cy", "label": "Cy" } ] } },
    "body": [
      { "type": "choice", "id": "who_pick", "bind": "who", "display": "list" },
      { "type": "button", "id": "vote", "label": "Vote", "act": { "say": "I vote for {{who}}.", "say_kind": "ooc" },
        "enable_if": { "not": { "key": "who", "empty": true } } }
    ],
    "runs_per_viewer": 1
  }
}
```

Your bot counts the `message.posted` lines with `via_hypertext_id` equal to the card, one per `via_user_id`, matching
the exact texts it expects ("I vote for Ada.") and ignoring anything else — a modified app could post any text, but only
one line per player. Close the card when everyone has voted.

### A pick with mutually exclusive outcomes

```json
{
  "hypertext": {
    "v": 1, "title": "The portrait",
    "body": [
      { "type": "text", "text": "The portrait's eyes seem to follow you." },
      { "type": "row", "children": [
        { "type": "button", "id": "lift", "label": "Lift the frame", "act": { "reply": "key" } },
        { "type": "button", "id": "slash", "label": "Slash the canvas", "style": "danger", "act": { "reply": "trap" } }
      ] }
    ],
    "runs_per_viewer": 1
  },
  "replies": {
    "key": { "text": "Behind the frame: a brass key, warm to the touch.", "audience": "viewer", "group": "portrait" },
    "trap": { "text": "The canvas splits, and so does the wall behind it.", "group": "portrait", "total": 1 }
  }
}
```

Each player gets one of the two outcomes; the key is whispered to the player who found it, and the trap springs once
for the whole table. `group` is per viewer: for a single outcome for the whole table, declare one reply with `total: 1`
and close the card when its line arrives.

### Closing

```sh
curl -s -X POST $API/channels/$CH/messages/$CARD/hypertext/close -H "Authorization: Bearer $TOKEN"
```

Any GM of the channel may close a card; readers are told at once (`hypertext.closed`) and their controls are disabled.
No action starts after it; one a viewer started just before still posts its lines. Recalling a card within 2 minutes of
posting it removes it entirely: it becomes a tombstone, its viewers' states and your templates are deleted, and an
action in flight posts nothing more.

## Scripts (apps)

The rest of this guide describes behaviour shipped in the apps; the server never runs a script. A script is for UI
logic that `act` cannot express (computed labels, multi-step forms, validating an input before posting). The
declarative examples above need none.

```js
// state declares "tries": {"type": "int", "min": 0, "max": 3}; a button has "on": "roll"
on('roll', (ev) => {               // ev = {type: 'click'|'change'|'submit', node, value}
  if (state.tries >= 3) { notify('No more tries.'); return }
  state.tries += 1
  say('.ra Spot Hidden')           // posted as the viewer
  if (viewer.gm) log('a GM tested the card')
})
```

- `on(name, fn)` registers a handler (top level only; registering a name twice throws); controls name it with `on`.
- `state`: a mutable copy of the viewer's state, taken after the control's own change was applied. Its new value is
  validated against your declarations.
- `viewer` (frozen): `{gm, actor, character}`, `character` being the name of the character the viewer's lines speak as
  (their composer's, else their character in the window), or null. No user id, locale, platform or time.
- `card` (frozen): `{title, replies: [ids]}`.
- `say(text, kind = 'ic')`: at most once per action; `ic` or `ooc`; 1–500 code points, at most 5 lines; the dice policy
  applies. Free text needs the viewer's confirmation ("Post as Ada: …"), and so does a roll that carries more than a
  bare expression or a short skill name (`.r 2d6+3 for damage`, a long `.ra …`), because its words are posted in the
  viewer's name. With the server's dice off every `say` is plain text, so every one is confirmed. A declarative
  `act.say` needs none (the button shows its text), except a dot command while the server's dice are off. An `ooc`
  line is posted under the viewer's account name, and the confirmation says so ("Post as Ann (out of character): …").
  A line speaks as the character the viewer's composer speaks as ("Speak as"), else their character in the window.
- `reply(id, slots = {})`: at most once per action; the slot names exactly as declared, the values declared.
- `notify(text)`: up to 3 short notes under the card, for this viewer only, never sent anywhere.
- `log(...values)`: up to 20 entries, shown only in the "Script details" box GMs see under the card.

Handlers are synchronous (returning a promise is an error). Each action runs in a fresh QuickJS (WebAssembly) instance
with no host functions: the script's only output is data — `{state, effects, notices, logs}` — which the app validates
(and the server validates again) before anything happens. Absent: `Date`, `Promise`, `Proxy`, timers, `Intl`, typed
arrays, `WeakRef`, `eval`, modules; `Math.random` throws ("roll dice with say('.r 1d6')"), because client-side
randomness can be forged. Each run gets 8 MiB of memory, a 128 KiB stack and a fixed instruction budget (the same on
every device, so a script either fits everywhere or nowhere); exceeding one stops the run. Any error aborts the action:
the viewer's state reverts, nothing is sent, players see "This message's action failed." and GMs see the error code
(`script_error`, `no_handler`, `budget`, `memory`, `stack`, `timeout`, `invalid_state`, `invalid_effect`,
`engine_unavailable`, `engine`), message and logs. Nothing is reported to the server or to you.

Devices without WebAssembly (iOS Lockdown Mode, very old Android WebViews) still render cards and run declarative `act`
buttons; only controls with `on` handlers are disabled ("Interactive actions are unavailable on this device.").

## Testing your cards

- Post to a test channel and read the 400 `errors`: each path points at the offending field of your post body.
- The shared contract `mobile/contracts/fixtures/hypertext.json` holds hundreds of accepted and refused cards, fallback
  texts, templates, dice verdicts, defaults, state checks, conditions and interpolations; it is what the server and
  every app are tested against.
- Act as a player with the curl above to see the response a viewer gets: the lines they may read, `partial`, the state.
- In the apps, GMs see a "Script details" box with a script's logs and errors **(apps)**.

## Upgrading the script engine (apps)

The engine is QuickJS compiled to WebAssembly (`quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync`,
pinned to the same exact version, both MIT). The same `.wasm` bytes run on every platform, and their SHA-256 is recorded
in `engine.wasm_sha256` of the shared fixture. To upgrade: bump both pins together, rebuild the mobile engine bundle,
update `wasm_sha256` and the size cap in the fixture, recalibrate the instruction budget if the measured cost changed,
and run every suite on every platform.
