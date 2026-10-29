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

Two things hold state: PostgreSQL and the media/object store (`uploads` volume, or the S3 bucket with `OBJECT_STORE=s3`).

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
