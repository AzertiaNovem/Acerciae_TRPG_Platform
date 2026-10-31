# Operating a deployment

The existing native systemd deployment on server-sh uses the [online deployment workflow](ONLINE_DEPLOYMENT.md).
The Docker instructions below apply to Compose installations.

## Before exposing it

1. **Secrets.** In `.env` set `AUTH_SECRET` and `PDF_WORKER_TOKEN` to two different values from `openssl rand -hex 32`, and
   change `POSTGRES_PASSWORD` (and the password inside `DATABASE_URL`). The backend refuses to start with a missing, short
   or published `AUTH_SECRET`. Keep it: changing it signs everyone out and makes every server's stored API keys
   unreadable (maintainers must enter them again).
2. **No demo data.** Leave `SEED_DEMO=false` and `ALLOW_INSECURE_DEV=false`. The demo accounts share the password
   `password` and are only seeded together with `ALLOW_INSECURE_DEV=true`.
3. **TLS in front.** Compose binds PostgreSQL (5432) and the backend (8080) to `127.0.0.1`; only the frontend (5173) is
   meant to be reached, and it must sit behind TLS. With Caddy, for example:

   ```
   play.example.org {
       reverse_proxy 127.0.0.1:5173
   }
   ```

   The bundled nginx forwards `/api` and `/ws` to the backend and sets `X-Real-IP`; compose sets `TRUST_PROXY=true` so
   login throttling sees real client addresses. If you put the backend behind your own proxy instead, set
   `TRUST_PROXY=true` only when the backend port is not reachable directly, and make the proxy overwrite `X-Real-IP`.
4. **Cross-origin access** stays closed unless `CORS_ORIGINS` lists an origin (the bundled frontend needs none).
5. **AI is per server.** There are no platform AI keys. Each server's maintainers configure providers, keys and the AI
   policy (token and image budgets, simultaneous AI tasks) in Server settings → AI. Provider endpoints must be https on
   a public address; set `AI_ALLOW_PRIVATE_ENDPOINTS=true` only for a trusted self-hosted model on your network, since any
   server maintainer could then point AI calls at internal addresses.

## Backups and restore

Two things hold state: PostgreSQL and the media/object store (`uploads` volume, the S3 bucket with `OBJECT_STORE=s3`, or the R2 buckets with `OBJECT_STORE=r2` / `IMAGE_STORE=r2` / `R2_PUBLIC_BUCKET`). Back up R2 with Cloudflare's tools (or `acerciae-server --copy-media r2 local` and `--copy-media r2public local` before a volume backup); the commands below cover the volume.

```bash
# backup (consistent dump while running)
docker compose exec -T db pg_dump -U acerciae -Fc acerciae > acerciae-$(date +%F).dump
docker run --rm -v acerciae_trpg_platform_uploads:/data -v "$PWD":/backup alpine tar czf /backup/uploads-$(date +%F).tgz -C /data .

# restore into a fresh stack
docker compose up -d db
docker compose exec -T db pg_restore -U acerciae -d acerciae --clean --if-exists < acerciae-YYYY-MM-DD.dump
docker run --rm -v acerciae_trpg_platform_uploads:/data -v "$PWD":/backup alpine tar xzf /backup/uploads-YYYY-MM-DD.tgz -C /data
docker compose up -d
```

Back up `.env` separately and securely: without the same `AUTH_SECRET` the stored server API keys cannot be decrypted.
(Volume names carry the compose project name; check them with `docker volume ls`.)

## Upgrades

Migrations in `backend/migrations` run automatically at startup, in order, each exactly once (`schema_migrations`).
Take a backup first, then `git pull && docker compose up -d --build`. `acerciae-server --migrate-only` applies them
without serving.

## Housekeeping and limits

- A maintenance thread re-checks WebSocket subscriptions every minute (expired sessions are closed, removed members stop
  receiving) and sweeps hourly: expired sessions, finished background AI jobs older than `RETENTION_AI_JOB_DAYS` (30),
  studio audit rows older than `RETENTION_AUDIT_DAYS` (365) and spent or revoked invites.
- Failing AI batches back off and are skipped after 5 attempts; a server's token and image budgets stop AI work when
  spent (429 `ai_budget_exhausted`) until the next period or a reset.
- Unexpected errors are answered with `internal error (reference <id>)`; search the backend log for that id.
- Login throttling, invite and WebSocket state live in the backend process: run **one** backend instance. Several
  instances behind a load balancer would each throttle separately and miss each other's socket revocations.
- The PDF worker polls the backend; PDF jobs stay pending while it is down (the backend warns at startup when
  `PDF_WORKER_TOKEN` is missing).

## Import output allowance

When upgrading the module-import workflow, review explicit environment overrides: use `LLM_MAX_TOKENS=8192`, `LLM_MODULE_MAX_TOKENS=32768` and `LLM_MODULE_TIMEOUT_MS=300000` for the new defaults. An older `LLM_MAX_TOKENS=2048` in an environment file still overrides the general default. Use a lower module allowance if a configured provider/model requires it; higher allowances are upper limits, not a request to pad every answer.

Migration 0031 adds durable import progress and content fingerprints. It does not delete or merge older modules. Imports interrupted by a backend restart become failed tasks that the Keeper can retry. Always poll the saved task after a network failure rather than assuming a rejected upload. The webpage uses asynchronous text imports; older clients retain their synchronous contract until they send `async:true`.

Module structuring handles persistent upstream HTTP 504 by reducing only pending input chunks from 12 KB to 6 KB and then 3 KB (smaller source chunks can reduce directly to the floor). Already accepted chunks are retained, original UTF-8 text and page references are preserved, and the progress total grows accordingly. There are at most two reductions per import; a provider that still times out fails the saved task rather than looping indefinitely. The existing transport retries each transient failure twice. This cannot override an upstream gateway deadline; retry the saved task after provider recovery instead of uploading again. Authentication, schema and token-limit errors do not trigger this fallback.

The OpenAI Responses API and Anthropic Messages requests use SSE streaming (`openai_compatible` posts to `{api_base}/responses`; servers that only offer Chat Completions are not supported). Text, tool calls and usage are taken from the stream's terminal event (`response.completed` or `response.incomplete` for OpenAI) before schema validation; incomplete streams never commit structured results. OpenAI requests set `store: false`, so the provider keeps no conversation state. Gateways that return a complete ordinary JSON response are still accepted. The provider timeout includes retries and backoff, including time in the connection queue. Silent reasoning/first-token waits use the same total deadline; no shorter low-speed timer cuts them off. Normal JSON requests have a 30-second response deadline. HTTP AI requests have a separate 90-second response deadline; an already-running model call may finish in its worker, while an expired queued call is skipped. This does not cancel external provider billing. The browser aborts stalled requests after 120 seconds and instructs users to check saved jobs before retrying.

KP knowledge generation uses batches of at most six primary nodes, associated edges and relevant source pages. HTTP 504 halves a failed batch down to one node. Results replace old generated knowledge only after all batches succeed; Keeper edits are preserved, and successful rebuilds clear the previous import warning. Migration 0032 adds durable GM-only rebuild jobs. The background pool has two workers; ordinary network handlers no longer execute KP builds, KP board refreshes, semantic LLM tools or live voice creation. Provider/API failures can still fail a job, but do not consume a network event-loop thread.

Protocol references: [OpenAI Responses streaming events](https://platform.openai.com/docs/api-reference/responses-streaming), [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).

## Thread and model connection isolation

`HTTP_THREADS` (default 4) controls Drogon's nonblocking socket loops. Normal JSON handlers run in `API_WORKERS` (8) with `API_QUEUE_LIMIT` (256); model-backed handlers run in the separate `AI_HTTP_WORKERS` pool (8). Async module and KP rebuild submission runs in the ordinary pool and returns a saved job immediately; the two background workers perform the build. A full handler queue returns HTTP 503. Queued work whose response deadline expires is skipped; already-running writes can still complete, so clients should check saved state before retrying.

OpenAI/Anthropic text and embedding HTTP calls share a dedicated libcurl multi reactor. It multiplexes up to `LLM_MAX_CONNECTIONS` (32) active transfers with `LLM_QUEUE_LIMIT` (128) additional admitted requests. Retries release their connection slot and wait on reactor timers, so backoff does not sleep on an IO thread. Queue wait, attempts and retry delays share one deadline. Overload and shutdown resolve futures with errors. The existing synchronous service interfaces wait for those futures only on AI/background workers: this is nonblocking socket IO, not a conversion of every business function to a coroutine. Endpoint DNS validation/pinning remains on the submitting worker, outside either network loop; system resolver delays are not forcibly cancelled. Database operations still use the existing synchronous connection pool. Media/file-specific handlers and WebSocket application handlers have not been converted by this change.

`http_transport_tests` exercises concurrent sockets, bounded admission, queued deadlines, retry fairness, response caps and shutdown. The HTTP streaming suite is also run with one network loop and two AI workers, and verifies ordinary reads/writes and job submissions while both AI workers are stalled.

Visual-novel scripts use independent `LLM_VN_MAX_TOKENS` (default 32768) and `LLM_VN_TIMEOUT_MS` (default 300000, per request). Daily limits can be reduced without reducing these. `VN_SCRIPT_RETRY_FAILED_CHUNKS=true` defaults new jobs to durable partial retries; the Studio can override it per job. See [visual-novel retry behavior](VISUAL_NOVEL.md#script-limits-and-retrying).
