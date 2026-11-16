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

The server checks and stores cards, keeps each viewer's state and posts the lines; it never runs a script. The web and
desktop app, the Android app and the iOS app draw cards and run their scripts, all in the same way; sections marked
**(apps)** describe what they do. gm-agent posts roll cards ([With gm-agent](#with-gm-agent)). An app build from
before cards shows a card's plain-text fallback instead, and reads it aloud like any other line.

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

gm-agent makes cards like this one in code, with its builders ([With gm-agent](#with-gm-agent)).

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
or recalled, when the viewer is not a member of the card's window or not one of its `actors`, for a spectator or the
demo, when the card sits in a forked window's history (it belongs to another window), when the window is archived, when
the viewer is paused there, and when the server has no interactive messages or has them turned off. A line under the
card says why. The server enforces the same rules.

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
| the stored card (with the reply stubs, which repeat every enum slot's values) / the reply templates | 60 KiB of JSON each, as the database stores it (400 `invalid_hypertext` at `replies`, or at `hypertext` for a card without replies) |
| script | 16 KiB |
| nodes / state keys / replies / slots / actors | 64 / 32 / 16 / 4 per reply / 10 |
| a viewer's state | 8 KiB |
| `content` / text node / reply template | 2000 / 2000 / 1000 code points |
| `say` | 1–500 code points after trimming, at most 5 lines (`\n`, U+0085, U+2028 and U+2029 each start a line) |
| a card's life | 60 s to 30 days (`closes_in`); 7 days by default |
| cards | 20 a minute per author and channel |
| actions | `runs_per_viewer` per viewer; 10 a minute per viewer and card, 30 per viewer and channel (failed actions count); 60 replies a minute per card |
| state saves | 120 a minute per viewer |
| status requests | at most 100 card ids each |

## The fallback text

Without `content`, the server writes the card's plain text itself, the same way every time and with no locale words:
the title, then one line per node visible under the default state.

| element | line |
|---|---|
| title | the title |
| text | the text, interpolated with the defaults |
| checkbox | `☐ label` |
| choice | `label: A / B / C` (its options' labels; `A / B / C` without a label) |
| input | `label: ____` (`____` without a label) |
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
| need the viewer's confirmation | `.sc`, `.ds`: they change the viewer's sheet. The server answers 428 `confirmation_required` until the request says `confirmed: true`, and the apps ask the viewer before they send that ("This changes your character sheet."). |
| refused | `.ri` with a name (it could overwrite another character's initiative), `.st`, `.en`, `.ss`, `.init`, `.move` |

`.ri` / `.rih` also need a card whose visibility is `window`: the initiative order is the whole window's, so a GM-only or
whisper card cannot add to it (403 `hypertext_command_not_allowed`).

A hidden roll (`.rh`, `.rah`) sends its result to the viewer's character when that character is inside the card's
audience, and its notice to the card's audience. With the server's dice turned off, a say posts as plain text, and a
say that looks like a dice command needs the viewer's confirmation like any free text: the server answers 428
`confirmation_required` with `sheet: false` until the request says `confirmed: true`. Rolls
from cards cannot be recalled, like any roll; other lines follow the normal 2-minute recall.

## What a viewer's app does

The web and desktop app, Android and iOS do the same. The card logic is written once in TypeScript
(`frontend/src/hypertext/`), ported to Kotlin (`core/Hypertext.kt`) and Swift (`AcerciaeCore/Hypertext.swift`), and
pinned by the shared fixtures; the details for app developers are in
[mobile/contracts/INTEGRATION.md](../mobile/contracts/INTEGRATION.md) (2026-11-14).

1. Renders the card natively from the document and the viewer's state; no JavaScript runs to render. The app asks
   `GET /channels/{c}/hypertext?ids=` for every loaded card when a window opens, after each reconnection and when new
   cards load. Controls show "Loading…" until the answer arrives.
2. On a control without a handler or `act` (a checkbox, a choice, an input's submit): applies the change and saves it
   (`PUT …/hypertext/state`, 500 ms after the last change). Leaving an input saves its draft and runs no handler; its
   button, or Enter outside an IME composition, submits it.
3. On a declarative `act`: computes the new state and the effects, then `POST …/hypertext/act` without asking (the
   button's caption showed the line), or a PUT when nothing is posted. A 428 asks the viewer and sends the action again.
4. On an `on` handler **(apps)**: runs your script for that one event ([Scripts](#scripts-apps)), shows the new state
   and notes, asks the viewer to confirm any free-text `say` or sheet change, then acts.

An action request is `{interaction_id, node, say?, reply?, state?, base_version}`. The app makes a new UUID per action
and reuses it when it retries, so a retry never posts twice; it sends the state version it acted on, and the server
refuses the action (409 `state_conflict`) when the viewer's state changed on another device meanwhile. A retry of an
action that finished replays its result even after you closed the card (a bot that closes a card as soon as its line
arrives does not break the viewer's retry). The response lists each line posted, re-read for the viewer: a line the
viewer may not read — your GM-only reply, the result of a hidden-roll reply — is `null` for them. Error codes are
listed in [API.md](API.md#interactive-messages).

What the apps do with the answers:

- No answer, a timeout or a 5xx: the same request again after 0.6, 1.8 and 4.5 s, then the action is undone.
- 409 `state_conflict`: the server's state is shown instead ("This message changed on another device."). Other
  refusals undo the action and show why.
- 405, or a 404 that is not the API's own JSON: the server has no interactive messages yet. 403 `feature_disabled`:
  the operator turned them off. Either way the cards stay drawn, with every control disabled.
- Pushes: `hypertext.state` brings a viewer's newer state to all their devices; `hypertext.closed` disables a card for
  everyone at once.
- Cards are never pinned (the server answers 409) and never read aloud; the lines they produce are ordinary lines.
- A card an app cannot read (another `v`, a document it cannot parse) shows its `content` with "Update the app to use
  this message."

An app build from before cards ignores the card fields: it shows `content` like a plain line, reads it aloud, and
refreshes once on each of the two unknown pushes. Write `content` so that it works as a line on its own.

You can drive the same route by hand to test a card:

```sh
curl -s $API/channels/$CH/messages/$CARD/hypertext/act -H "Authorization: Bearer $PLAYER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"interaction_id":"'"$(uuidgen)"'","node":"roll","say":{"text":".ra Spot Hidden"},"state":{"done":true},"base_version":0}'
```

## The security model in plain words

- **The card is public to its readers.** The document, the script, the reply stubs (ids, slot names and values,
  audience, group) and every state declaration are sent to everyone who can read the card (spectators get it without
  the script), and kept in the apps' caches. Do not put spoilers there. Spoilers belong only in reply templates, which
  never leave the server: not in the message, its events, exports, caches, the campaign log or any response.
- **Scripts are UI, not referees.** A modified app can ask for any of your declared replies, with any declared slot
  values, within their limits, and can post any line the viewer could type. So never let a script decide a secret or a
  success: decide it in your bot (from the lines that arrive) or with a server dice roll. Use `group` and `total` for
  mutually exclusive outcomes. The worst a forged app can achieve is: you say one of your own lines, with values you
  listed, within your limits, to the audience you chose, labelled "via {player}".
- **Each viewer's state is theirs.** No route lets a GM or a bot read it. It can still reach you, but only through lines
  the viewer's actions post — including replies whose slot values a script fills from the state — so treat anything a
  viewer types into a card as something they may share. Apps say so under every input ("Anything you type here may be
  shared in the chat."). The platform's operator holds the stored states, deleted when the card is recalled or the
  channel is deleted, and each action's request, deleted a day after the card closes.
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

## With gm-agent

gm-agent builds its cards in code, from declarative parts only, with the builders of
[`gm-agent/src/hypertext.mjs`](../gm-agent/src/hypertext.mjs). Its model never writes a card and no builder writes a
`script`. Each builder returns the body for `POST /channels/{c}/windows/{w}/hypertext`, or `null` when it cannot make
a card the server accepts; then post the plain line instead. Text from anywhere (the model, a character's name) is
cleaned first: refused characters are dropped, `{{` is broken up, line breaks become spaces in one-line fields, and
everything is cut by code points to the v1 limits. The builders' own words ("Roll for Ada", "Choose") follow
`language`, the table's language name or code: any of the 11 table languages (English, Simplified and Traditional
Chinese, Japanese, Korean, Spanish, French, German, Russian, Portuguese, Italian), else English.

| builder | parameters | the card |
|---|---|---|
| `rollRequest` | `command` (required): one roll a card may post as the player (`.r`, `.ra`, `.rc`, the hidden forms, `.ri` with modifiers, `.sc`, `.ds`); `pcId` (required): the player's character; `text`: the narration; `name`: the character's name; `language`; `content` | Title "Roll for {name}", the narration, and a button named after the roll ("Roll Spot Hidden", "Roll initiative", "Sanity check 1/1d6") whose `act` posts `command` as the player and sets `done`, which greys it out. `actors: [pcId]`, `runs_per_viewer: 1`. `content` defaults to "{text}\n→ {name}: {command}". `null` for any other command or more than one line. |
| `choice` | `options`: 2–20 labels (duplicates dropped, ignoring case); `prompt`; `actorIds` (at most 10; empty: every reader); `title`; `kind` (`ooc` by default, or `ic`); `language`; `content` | Title (default "Your choice"), the prompt, a choice bound to an enum `pick` with values `o1`…`oN` (buttons for up to 5 options, else a list), and a "Choose" button that posts "I choose: {{pick}}" as the reader and sets `done`. One answer per reader. `content` defaults to the prompt and "A / B / C". `null` with fewer than 2 options. |
| `checklist` | `items`: 1–30 labels; `title`; `actorIds`; `language` | Title (default "Checklist"), one checkbox per item (bool keys `i1`…`iN`), and "All done." once every box is ticked (for up to 8 items: a condition holds at most 8 leaves). Nothing is posted; each reader's ticks are saved for them. No `content`, so the server writes the fallback. |

For example, this call:

```js
import { rollRequest } from "./src/hypertext.mjs";   // inside gm-agent
const body = rollRequest({ text: "Something glints under the desk.", command: ".ra Spot Hidden",
                           pcId: "6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7", name: "Ada", language: "English" });
if (body) await api.postHypertext(channelId, windowId, body);   // api: gm-agent's client (src/api.mjs)
```

builds this body:

```json
{
  "content": "Something glints under the desk.\n→ Ada: .ra Spot Hidden",
  "hypertext": {
    "v": 1,
    "title": "Roll for Ada",
    "state": { "done": { "type": "bool" } },
    "body": [
      { "type": "text", "text": "Something glints under the desk." },
      { "type": "button", "id": "roll", "label": "Roll Spot Hidden",
        "act": { "say": ".ra Spot Hidden", "set": { "done": true } },
        "enable_if": { "key": "done", "eq": false } }
    ],
    "actors": ["6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7"],
    "runs_per_viewer": 1
  }
}
```

**`request_roll`.** Only this action of the agent posts a card (`requestRoll` in
[`gm-agent/src/table/actions.mjs`](../gm-agent/src/table/actions.mjs)); `choice` and `checklist` are for your own
code. When the agent's model asks a character for a roll:

1. A co-player or an NPC rolls for itself, as before: the narration, then the command as its own line. PbtA tables ask
   for no rolls.
2. For a character a person plays, the roll is asked for in that player's own scene. The agent builds `rollRequest`
   with `content` set to the line it posted before cards ("{text}\n→ Ada: .ra Spot Hidden") and posts it with
   `sendHypertext` (`visibility: "window"`).
3. If the builder returns `null` (`.ss`, or `.ri` with a name: rolls the rules may ask for but a card may not post) or
   the post fails, the agent posts that line as narration instead. A command the table's rules do not allow is never
   asked for: the agent posts only the narration. A 404 or 405 (a server from before cards) or a 403 `feature_disabled`
   also sets `table.hypertextSupported` to false: the agent logs it once and posts plain lines until it restarts. Any
   other refusal (a rate limit, an archived window) falls back for that one card, and the log lists the 400 `errors`
   paths.
4. The agent keeps its open roll cards in its state file, by window, character and roll. Asking for the same roll again
   closes the older card.
5. When a line answers the card, the agent closes it (`api.closeHypertext`). A line answers it when it came from the
   card (`via_hypertext_id` is the card's id), or when the same character typed the same roll after the card: the
   command's name and the skill's words count, numbers and the hidden form do not, so `.rc spot hidden 60` answers
   `.ra Spot Hidden`. A failed close is only logged; a card nobody closes closes itself after the default 7 days. A
   recalled card is forgotten.

The agent's models read a card as its `content`, tagged "(interactive message)", and never see its buttons, state or
script; [gm-agent/README.md](../gm-agent/README.md#interactive-messages-roll-cards) has the details.

## Scripts (apps)

Scripts run only in the apps (web, desktop, Android and iOS), on the viewer's device; the server never runs one. A
script is for UI logic that `act` cannot express (computed labels, multi-step forms, validating an input before
posting). The declarative examples above need none, and the gm-agent builders never write one.

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
- `notify(text)`: up to 3 notes of 1–200 code points under the card, for this viewer only, never sent anywhere.
- `log(...values)`: up to 20 entries of at most 200 code points (longer ones are cut), shown only in the "Script
  details" box GMs see under the card.

Handlers are synchronous (returning a promise is an error). Each action runs in a fresh QuickJS (WebAssembly) instance
with no host functions: the script's only output is data — `{state, effects, notices, logs}`, at most 16 KiB of JSON
nested at most 16 deep — which the app validates (and the server validates again) before anything happens. Absent:
`Date`, `Promise`, `Proxy`, timers, `Intl`, typed arrays, `WeakRef`, `eval`, modules; `Math.random` throws ("roll dice
with say('.r 1d6')"), because client-side randomness can be forged.

Each run gets 8 MiB of memory, a 128 KiB stack and a step budget of 50 interrupt polls (about 250,000 loop iterations).
The step budget cuts a run off at the same point on every device. Built-ins that work in C without polling (long
`join`, `repeat`, substring searches, `JSON`) are charged to a second, fixed work budget. A run also stops after 500 ms
(`timeout`), so a script close to that mark may finish on a fast device and fail on a slow one: keep scripts small.
The host ends a run that does not answer within 1 s (5 s for the first run, which loads the engine). Any error aborts
the action: the viewer's state reverts, nothing is sent, players see "This message's action failed." and GMs see the
error code (`script_error`, `no_handler`, `budget`, `memory`, `stack`, `timeout`, `invalid_state`, `invalid_effect`,
`engine_unavailable`, `engine`), message and logs. Nothing is reported to the server or to you.

Where a script runs. The engine is created on the first run of a control with `on`, never for cards without
handlers, and never for spectators or the demo.

- **Web and desktop:** a module worker (`frontend/src/hypertext/hypertext-worker.ts`). It fetches and compiles the
  QuickJS WASM once, then removes `fetch`, `XMLHttpRequest`, `WebSocket`, storage and the other network APIs from its
  own scope before it handles a run. It never gets a token, and its messages are JSON of at most 64 KiB. The worker
  is served with its own Content-Security-Policy (only its own chunks and the WASM, from the same origin). It is
  replaced when a run does not answer within 1 s (5 s for the first), when the engine could not load, and after 500
  runs, and dropped on sign-out.
- **Android:** a hidden WebView with network loads blocked, no file or content access, no DOM storage and no
  JavaScript bridge. It serves only the engine's two files from the app (and lets the page start its own `blob:`
  worker) and refuses every other load; results come back through `evaluateJavascript`. It is destroyed after 2
  minutes without a run, in the background, when a run does not answer in time and when its renderer stops, without
  touching the app's other web views.
- **iOS:** a hidden WKWebView with a data store that keeps nothing, no script message handlers, a content rule list
  that blocks every load except the engine's own files and the worker it starts, and a navigation delegate that cancels
  every navigation after the first. It is dropped after 2 minutes without a run, in the background, when its process
  ends and when a run does not answer in time.
- On Android and iOS the page runs `mobile/contracts/hypertext/hypertext-engine.js`: the same engine code with the same
  WASM bytes inlined, built by `mobile/scripts/build-hypertext.mjs`. The app checks every result again in Kotlin or
  Swift before it shows or sends anything.

Devices without WebAssembly (iOS Lockdown Mode, jitless or very old Android WebViews) still render cards and run
declarative `act` buttons; only controls with `on` handlers are disabled ("Interactive actions are unavailable on this
device.").

## Testing your cards

- Post to a test channel and read the 400 `errors`: each path points at the offending field of your post body.
- Act as a player with the curl above to see the response a viewer gets: the lines they may read, `partial`, the state.
- In the apps, GMs see a "Script details" box under a card with its script's last error and logs **(apps)**.
- The shared contract is two fixtures. `mobile/contracts/fixtures/hypertext.json` holds accepted and refused cards,
  fallback texts, reply templates, dice verdicts, defaults, state checks, conditions and interpolations; the server and
  every app are tested against it. `mobile/contracts/fixtures/hypertext-client.json` holds what the apps do with a card
  (bindings, the drawn nodes for every lock reason, declarative acts, a stored state drawn over the defaults) and the
  engine cases (`runs`) with the engine's limits and WASM hash. A case there is a good model for a card of your own.
- `scripts/test.sh` (with the backend built in `backend/build`; CI runs it too) runs every layer against throwaway
  databases on a local PostgreSQL: the C++ unit and database tests, the integration suites
  (`tests/integration/hypertext.test.mjs` drives the five routes over HTTP and WebSocket, the secrecy of templates
  included; `tests/integration/gm-agent-hypertext.test.mjs` posts every gm-agent builder's card and closes a roll card
  on its roll), gm-agent's tests (`gm-agent/test/hypertext.test.mjs`), the frontend tests
  (`frontend/tests/hypertext-*.test.cjs`, the engine over every `runs` case included) and a check that the mobile
  engine bundle is the build of the current code.
- `RUN_BROWSER_TESTS=1 scripts/test.sh` adds the browser checks: `scripts/test-browser.sh` starts the web app against
  that backend and runs `tests/browser/hypertext.mjs` (and the other browser suites) in Chromium and WebKit. Against a
  local stack you already run, `WEB_BASE=<the local web address> npm --prefix tests/browser run test:hypertext` runs
  the card suite alone in both engines; it refuses any host but `127.0.0.1` and `localhost`. Install the
  `tests/browser` dependencies and the Playwright browsers first.

## Upgrading the script engine (apps)

The engine is QuickJS compiled to WebAssembly (`quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync`,
pinned to the same exact version, both MIT; see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)). The same `.wasm`
bytes run on every platform, and their SHA-256 is recorded as `engine.wasm_sha256` in both fixtures. To upgrade:

1. Bump both pins together in `frontend/package.json` and its lockfile.
2. Rebuild the mobile engine bundle: `node mobile/scripts/build-hypertext.mjs` (`scripts/test.sh` runs its `--check`
   form).
3. Update `wasm_sha256` and `max_bundle_bytes` in both fixtures, and `wasm_bytes`, `packages` and `version` in
   `hypertext-client.json`. In `frontend/tests/hypertext-engine.test.cjs`, update the pinned `wasm_sha256` and the
   `@jitl/quickjs-ffi-types` version it expects in the lockfile. The version string is also `ENGINE_VERSION` in
   `frontend/src/hypertext/engine.ts` and `engineVersion` in `AcerciaeCore/Hypertext.swift`.
4. Recalibrate `interrupt_polls` if the measured cost changed: in `engine.limits` of both fixtures and in
   `ENGINE_LIMITS` in `frontend/src/hypertext/engine.ts`.
5. Update the versions and license texts in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), and the `/*!`
   license comment in `frontend/src/hypertext/hypertext-worker.ts` (the web worker asset keeps it) and in
   `mobile/hypertext/engine.ts` (the mobile bundle keeps it, `legalComments: 'eof'`). The two must stay equal.
6. Run every suite on every platform.
