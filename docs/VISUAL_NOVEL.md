# Visual novel: look templates and LLM scripts

A visual novel in Log Studio is a presentation over one frozen snapshot. Two features shape it:

- **Look templates** decide how the player draws every line.
- **Script jobs** have the LLM read the chat log of every window it is allowed to see and organise it into scenes and staging. The job then builds a draft presentation in a chosen template.

Neither feature changes canonical text. A script references log events by id, and the player shows those events verbatim.

![The four look templates](screenshots/vn-templates.png)

## Look templates

A presentation stores its template in `settings.template`: a base preset plus optional overrides. Keys that are absent take the preset's value, so a later change to a preset reaches presentations that never overrode it. The backend validates every value and drops unknown keys (`PresentationService::validateVnTemplate`). The player re-checks values and turns them only into enumerated class names, clamped numbers and `#RRGGBB` colours. No template value can carry free CSS, HTML or URLs.

| Base | Look | Defaults that differ from Classic ADV |
|---|---|---|
| `adv` Classic ADV | Bottom text box, floating name tag, standees in front | None |
| `nvl` Novel page | Full-height page; the scene's earlier lines stay above the current one | Serif, names inline, dice inline, corner caption for scene titles |
| `dossier` Case file | Typewritten paper slip with a red margin rule over a sepia scene; rolls are stamped | Typewriter face, sepia grade, stamp dice, corner caption |
| `cinematic` Cinematic | Letterbox bars, subtitles without a box | Serif, larger text, names in small caps, cold grade, letterbox |

| Key | Values | Meaning |
|---|---|---|
| `base` | `adv` · `nvl` · `dossier` · `cinematic` | Preset (required) |
| `font` | `sans` · `serif` · `mono` | Typeface family; CJK fallbacks included |
| `text_scale` | 0.8–1.5 | Text size relative to the stage width |
| `box_opacity` | 0–1 | Text box background |
| `accent_color` | `#RRGGBB` | Default name tag, highlighted words, progress bar |
| `name_style` | `tag` · `inline` · `hidden` | Speaker name placement |
| `color_grade` | `none` · `sepia` · `mono` · `cold` · `warm` | Filter on background and standees, never on text |
| `letterbox` | boolean | Black bars above and below |
| `dim_inactive` | boolean | Darken standees that are not speaking |
| `dice_style` | `burst` · `stamp` · `inline` · `hide` | How a roll's total and outcome appear |
| `scene_card` | `fade` · `caption` · `none` | How a new scene's title appears |
| `character_colors` | character id → `#RRGGBB` (≤ 200) | Name colours |

A speaker's name colour comes from the line's own `dialogue_style.name_color`, then from `character_colors`, then from the character's visual profile colour, then from the accent. Text sizes scale with the stage through container query units, so the editor preview and fullscreen keep the same proportions. In the editor, the **Look template** panel under the preview shows the four presets and every override. Changes apply to the preview at once and save half a second after the last edit. Publications copy the presentation, so a published visual novel keeps the template it had when it was published.

## Script jobs

Only GMs run script jobs. The **Generate a visual novel from the chat log** panel on the Visual novel tab does it in one step:

1. It syncs every chat window into the "Campaign log" project, or into the project already open. Sync only adds events it has not seen.
2. It freezes a snapshot. **All chat windows** takes `gm_full`, which includes private windows and GM-only lines, so the result is GM only. **Player-visible lines only** takes `pl_public`. The third choice uses the snapshot already open in the Library, which can be one character's point of view.
3. It queues `POST /vn-scripts` with the template and an optional direction from the GM.
4. A worker thread plans the script, validates it and builds a draft presentation. The panel follows progress through `studio.vnscript.progress` events, with polling as a fallback.

### What the model sees

- **Lines:** only the snapshot's lines. Each line goes out as `{ref, window, scene, who, speaker, type, text, roll}`, with text cut to 1,500 bytes for the prompt only. Logs are sent in parts of at most 90 lines or about 14,000 characters. Each part carries the last eight open scenes so a thread can continue across parts.
- **Cast:** only characters who speak in the snapshot or whose full name already appears in it. An NPC the players have not met cannot be named in a player-facing title or summary.
- **Assets:** approved backgrounds, music and standees. A snapshot that is not `gm_full` never sees GM-only images.
- **GM direction:** at most 1,000 characters, labelled as data.

The system prompt forbids writing, rewriting, translating, shortening or merging dialogue, and forbids inventing facts.

### What is accepted from the model

`VnScriptService::normalize` keeps only:

- **References:** line refs that exist, each placed once, plus cast and asset refs from the lists sent.
- **Enumerations:** display kinds, positions, effects and environments from fixed sets.
- **Text fields with length limits:** titles, locations, moods, summaries, briefs and delivery notes.

Anything else is ignored, including any text the model returns for a line.

- **Excluded lines.** Lines the model excludes with a reason are hidden in the draft, never deleted, and keep that reason.
- **Skipped lines.** Lines the model skips stay visible. They go into the scene of a neighbouring line from the same window and canonical scene. Scene markers join the scene that follows them.
- **Scene order.** Scenes are ordered by their first line. Lines inside a scene keep canonical order. Parallel chat windows therefore read as continuous threads instead of interleaving.
- **Staging.** It carries forward until a line changes it. Standees are chosen by expression, then the character's default, then any approved standee of that character.

`PresentationService::applyScript` writes the result over a fresh presentation. It re-checks each asset (approved, same channel, right type, visible to the presentation's audience) and freezes asset versions.

### Mock mode and cloud policy

- **Mock mode.** Without an LLM API key, the job uses a deterministic planner. It groups lines by chat window and canonical scene, excludes out-of-character, system and unrecognised lines with reasons, and stages speakers. It also matches backgrounds by name. Its script carries a `MOCK` note and no summaries.
- **Live model.** With a real model, the request needs `allow_cloud: true`, and the campaign's Log Studio cloud setting must be on. Both are checked again when the job runs. The requester must still be a GM at that time too.
- **Retries.** Failed model calls retry once.
- **Timeouts.** Large parts can take a while on slow models. Raise `LLM_TIMEOUT_MS` if parts time out.

### Limits

- A job accepts at most 4,000 lines; snapshot a range or a set of scenes for longer campaigns.
- The script does not generate art. Scenes without a fitting approved background carry a brief, and the job lists `asset_needs`; the GM can take those to the image generator or upload art.
- The draft is a starting point. Review it in the editor before publishing.

The stored script format is in [VN_SCRIPT_SCHEMA.json](VN_SCRIPT_SCHEMA.json). The template keys are also in [PRESENTATION_SCHEMA.json](PRESENTATION_SCHEMA.json) under `settings.template`.
