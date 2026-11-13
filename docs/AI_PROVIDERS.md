# AI providers and model uses

A server's maintainers (owner and admins) configure AI in **Server settings → AI services**. There are no platform keys:
a server only calls what is configured here, with its own keys, and runs the labelled mock otherwise.

Configuration has two parts:

1. **Providers.** Each provider is a connection of a known kind: its endpoint (the kind's default, or any URL you give
   it), its key, and the kind's other fields. A server can have several providers, including two of the same kind.
2. **Model uses.** Each use names a provider and a model. A use only accepts a provider whose kind can do that job. For
   example, Stability AI makes images, so it is never offered for text or embeddings.

## Kinds

| Kind | Text | Embedding | Image generation | Image editing | Speech | Protocol |
|---|:-:|:-:|:-:|:-:|:-:|---|
| OpenAI-compatible (`openai`) | ✓ | ✓ | ✓ | ✓ | ✓ | Chat Completions, `/embeddings`, `/images/generations` and `/images/edits`, `/audio/speech` |
| Anthropic-compatible (`anthropic`) | ✓ | | | | | Messages API |
| Responses API-compatible (`responses`) | ✓ | ✓ | | | | Responses API (streamed; sealed reasoning is replayed between turns), `/embeddings` |
| Google (`google`) | | ✓ | ✓ | ✓ | ✓ | Gemini Interactions API for images and speech; `models/{m}:embedContent` for embeddings |
| AWS (`aws`) | | ✓ | ✓ | ✓ | ✓ | Bedrock InvokeModel (Titan v2 or Cohere embeddings; Stability models on Bedrock for images) and Polly, signed with SigV4 |
| Alibaba Cloud (`alibaba`) | ✓ | ✓ | ✓ | ✓ | ✓ | compatible mode (`/compatible-mode/v1`) for text and embeddings; Qwen-Image and Qwen TTS on DashScope |
| OpenRouter (`openrouter`) | ✓ | ✓ | ✓ | ✓ | ✓ | `anthropic/*` models use its Messages endpoint, other models use Chat Completions; `/embeddings`, `/images`, `/audio/speech` |
| Volcano Engine (`volcengine`) | ✓ | | ✓ | ✓ | ✓ | Ark Chat Completions and Seedream `/images/generations`; Doubao speech V3 |
| Stability AI (`stability`) | | | ✓ | ✓ | | Stable Image v2beta (`generate/{sd3,core,ultra}`; image-to-image for edits) |

`GET /api/ai/catalog` returns the same table for clients. Each kind entry lists its capabilities, default endpoint,
fields (`secret`, `text` or `url`, and whether each is required), suggested models per capability, and notes.

Fields beyond the API key:

- **AWS:** region and access key ID are required. The secret access key is the main key. A session token is optional
  (for temporary credentials). You can also override the Polly endpoint. The Bedrock endpoint defaults to
  `https://bedrock-runtime.{region}.amazonaws.com`.
- **Volcano Engine:** the Ark API key is used for text and images. Speech needs either a speech API key (new console)
  or a speech app ID and access token (old console). The speech resource ID and speech endpoint are optional.

## Uses

| Use | Takes | Default | Notes |
|---|---|---|---|
| `text` | text | mock | every text task |
| `text_chronicle` | text | inherit | optional override for the chronicler and Keeper: observer, consolidation, reminders, scenario detection and summaries, Keeper board/review, channel atmosphere |
| `text_assist` | text | inherit | optional override for player assists: consistency check and Inspiration |
| `text_writing` | text | inherit | optional override for long writing: visual-novel scripts, log performance, module import, script knowledge |
| `embedding` | embedding | off | semantic recall over the chat log; vectors are fitted to 1536 dimensions |
| `image_generation` | image generation | off | backgrounds, portraits, illustrations, atmosphere |
| `image_edit` | image editing | inherit | requests with reference images (poses, outfits, styled references); inherit = the generation provider |
| `tts` | speech | mock | Voice Studio and visual-novel voices |

A use is set to one of:

- a **provider id** plus a model;
- **`mock`**: rule-based text, test-pattern images or tone audio;
- **`disabled`**;
- **`inherit`**: available for the text overrides and for image editing.

Use options:

| Use | Options |
|---|---|
| Text | `reasoning_effort`, sent only to the OpenAI-compatible, Responses and OpenRouter kinds |
| Images | `size` (auto, 1024x1024, 1536x1024, 1024x1536; other kinds map it to an aspect ratio) and `quality` (OpenAI) |
| Speech | `voice`, the default voice |

When image editing has a provider of its own, reference requests go to it. If it is turned off, or follows a generation
provider that cannot edit, the request is sent without its references.

## API

All of these are maintainer-only except the catalog.

| Method | Path | |
|---|---|---|
| GET | `/api/ai/catalog` | `{kinds, uses}` (any signed-in user) |
| GET | `/api/servers/{s}/ai` | `{providers: [{id, name, kind, api_base, api_key_set, api_key_hint, options, secrets: {field: {set, hint}}, used_by: [use]}], uses: {use: {provider, model, options}}}` |
| POST | `/api/servers/{s}/ai/providers` | `{kind, name, api_base?, api_key?, options?: {field: value}, secrets?: {field: value}}`. Required fields are checked; unknown fields are refused (400); the name is unique (409); at most 30 providers |
| PUT | `/api/servers/{s}/ai/providers/{p}` | same fields. The kind cannot change. `clear_api_key: true` removes the key, and a `secrets` field set to `null` or `""` removes that secret |
| DELETE | `/api/servers/{s}/ai/providers/{p}` | uses that named the provider go back to their defaults |
| PUT | `/api/servers/{s}/ai/uses` | `{uses: {use: {provider: id \| mock \| disabled \| inherit, model?, options?}}}`. 400 when a provider's kind cannot do the use, a mode is not allowed for it, a live use has no model, or an option does not belong to it |

`GET /api/servers/{s}/settings` also returns `ai` (the same view) for maintainers. It still returns the old
single-provider `llm`, `image` and `tts` objects, and `PUT …/settings` still accepts them. The server translates them
to and from providers and uses: a group sent back unchanged changes nothing, and changing one assigns or creates a
provider for that group. The mobile apps' server settings page uses this compatibility layer.

## What each adapter does

- **Text.** Chat Completions is streamed with `stream_options.include_usage`. Tool calls are reassembled from deltas.
  OpenAI's own API is sent `max_completion_tokens`; other endpoints get `max_tokens`. Alibaba's text calls go to
  `{endpoint}/compatible-mode/v1`. OpenRouter's `anthropic/*` models go through Anthropic's Messages format with a
  bearer key.
- **Embeddings.** OpenAI-style endpoints are asked for 1536 dimensions, and asked again without the field if the
  model refuses it. Gemini is asked for 1536 and renormalised. Titan v2 (1024) is zero-padded, which keeps every
  cosine similarity. Cohere embed v4 is asked for 1536.
- **Images.**
  - GPT Image: generations, or edits as multipart.
  - Gemini: one Interactions call with `response_format: {type: image}`; references are sent as inline images.
  - Qwen-Image: the result URL is only fetched from `*.aliyuncs.com`.
  - OpenRouter: the `/images` endpoint, with `input_references`.
  - Seedream: `b64_json`, with the watermark off.
  - Stability: multipart. Standees then go through `remove-background`, since generation cannot make transparency.
  - Bedrock: Stability models with JSON bodies. Amazon's own image models (Nova Canvas, Titan Image) have reached end
    of life.

  Only GPT Image (and Stability, through background removal) produces transparent standees; the other kinds draw them
  on a plain background.
- **Speech.**
  - OpenAI and OpenRouter: `/audio/speech` as PCM.
  - Qwen: unchanged.
  - Gemini: Interactions with `audio/l16` at 24 kHz, a prebuilt voice, and the delivery instruction as the line's
    style.
  - Polly: PCM at 16 kHz; the model field is the engine.
  - Doubao: the V3 one-way stream, with base64 PCM chunks joined.

  Every result is stored as a WAV with a measured duration.
- **Retries.** Image and speech jobs make one attempt per try; their workers retry 429/5xx on their own schedule. Text
  and embeddings use the AI transport's retries.

## Migration from the single-provider settings (0066)

Migration `0066_ai_providers.sql` copies every server's old `llm_*`, `image_*` and `tts_*` settings into providers and
uses. Sealed keys are copied as they are, so the deployment's `AUTH_SECRET` must not change. The old columns stay in
place, unread, so the previous release can still be restored from its backup. The whole migration runs in the startup
transaction: it either applies completely or not at all.

| Old setting | Becomes |
|---|---|
| `openai_compatible` + key | a "Language model" provider of kind `responses`; the text use (with its reasoning effort); embedding when an embedding model was set |
| `anthropic` + key | a "Language model" provider of kind `anthropic`; the text use |
| LLM `mock` with a stored key | the same provider, remembered by the text use in mock mode (switching back reuses it) |
| `gpt_image` + key | an "Images" provider of kind `openai`; image generation and image editing with its model, size and quality. The image configuration id, which queued jobs are checked against, is unchanged |
| image `mock` / `disabled` | the same mode (a stored key is remembered) |
| `qwen` / `openai` speech + key | a "Voice" provider of kind `alibaba` / `openai`; the speech use with its model and voice. Provider names `qwen` and `openai` are unchanged, so voice profiles and cached audio stay valid |
| speech provider without a key | speech off, as before |
| no settings row | the defaults: text mock, images off, speech mock |

These cases were rehearsed on a database built at the previous schema, then migrated: keys decrypt, every channel
reports the same mode, provider and model as before, and a queued image job keeps its configuration id. One visible
difference: a server whose GPT Image setting had no key now reports images as off. It used to report them as on,
although no image could be made.

## Verification and limits

Tested against local protocol fixtures (never against the real paid services):

- **End to end:** `tests/integration/ai-provider-kinds.test.mjs` covers:
  - Chat Completions text, streamed, with a tool round;
  - images from Stability, OpenRouter, Seedream and Stability-on-Bedrock (SigV4 headers checked);
  - image edits on Gemini;
  - speech from Doubao, Gemini and Polly (SigV4).

  `tests/integration/ai-providers.test.mjs` still covers the Responses API, Anthropic, GPT Image and OpenAI speech.
- **Unit tests:** request shapes, stream parsing, the official AWS Signature V4 test vectors, and embedding fitting.
- **Not exercised end to end:**
  - embeddings (any kind);
  - Qwen-Image (it only downloads results from `*.aliyuncs.com`, which a local fixture cannot serve);
  - OpenRouter's Messages endpoint for `anthropic/*` models.

The contracts follow the providers' documentation as of November 2026. Model ids in the catalog are suggestions; the
model field takes any id your account offers.
