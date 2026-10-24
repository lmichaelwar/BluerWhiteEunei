# Eunnei on Cloudflare

One Worker serves the private office and API. One named SQLite Durable Object owns the ChatGPT registration, rotating credentials, stable host ID, request limits and quota cooldown. There is no Ollama process, always-on laptop, API-key fallback or container.

The original bridge code is MIT licensed. This does not relicense Aphae or its assets. OpenAI documents moving a locally authorized OSS-client session into protected self-hosted runtime storage for the same user and workspace. Using that architecture for this personal Cloudflare deployment is an implementation inference; the documentation does not name Cloudflare specifically. A hosted product offered to other users is a different scope. References: [plan usage](https://developers.openai.com/siwc/token-sharing-open-source), [self-hosted procedure](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), [session storage and refresh](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

## Prepare and verify offline

Use Node 22 or newer. From this directory:

```sh
npm ci
npm test
npm run check
```

The original Node bridge tests remain separate:

```sh
cd ../cloud
npm test
```

The Worker serves the prepared `../build/site` directory. Create the Godot Web export at `build/web/index.html` using the repository's Web export preset, then run from the repository root:

```sh
python3 tools/package_web.py build/web build/site
```

Use the packaged site, not the raw export: packaging splits the large WebAssembly engine into eight-MiB pieces, preserves the exact engine bytes, and includes the viewing shell. Build artifacts are not committed.

## Deploy privately

Reuse the existing authenticated Cloudflare account. `npx wrangler whoami` reports the selected account without creating a new login. Review `wrangler.jsonc` before deploying. The deployment creates one Worker and its SQLite Durable Object namespace; it does not require a VM or Container.

Keep the office and API under the same HTTPS origin. Browser access uses Cloudflare Access; the Worker validates the signed Access assertion and the allowed account identity. A separate machine `BRIDGE_KEY` can authenticate trusted proxy or import requests. Never add either that key or OpenAI credentials to HTML, JavaScript, URLs or browser storage.

`assets.run_worker_first` must remain enabled. This makes authorization run before static files, including the Godot binary chunks. Protect the entire Worker domain and any enabled preview domain with Access; do not leave an alternate deployment hostname outside the policy.

Set `CF_ACCESS_TEAM_DOMAIN` to the Access team HTTPS origin (for example `https://your-team.cloudflareaccess.com`), `CF_ACCESS_AUD` to the Access application's audience, and pin `CF_ACCESS_ALLOWED_SUB` and/or `CF_ACCESS_ALLOWED_EMAIL` to the owner. Put these values in Wrangler `vars` or secrets. If both identity pins are configured, both must match. Use Wrangler secrets for private configuration. Configure distinct `BRIDGE_KEY` and `ADMIN_KEY` values, each at least 24 characters. Import requires primary authorization plus `X-Eunnei-Admin-Key`. Cloudflare account authentication authorizes deployment; it does not grant permission to consume the ChatGPT plan.

```sh
npx wrangler secret put BRIDGE_KEY
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

These are deployment instructions, not evidence of a completed deployment. The app must remain unavailable to unauthenticated requests even before credentials are imported.

## Connect ChatGPT plan usage

Keep using the original local helper on the computer whose browser will complete consent:

```sh
cd ../cloud
npm run auth
```

The official first-time callback is `http://127.0.0.1:<port>/auth/callback`. Replacing it with the Cloudflare hostname is not the documented registration flow. The helper validates the issued registration and plan-usage scope, saving a protected record at `~/.config/eunnei/credentials.json` by default. Do not import a Codex token or another app's registration.

Transfer that record once to the protected `/admin/import` endpoint over HTTPS. Import preserves the Cloudflare deployment's distinct host identity. The Durable Object then owns token rotation; stop using the local copy for live requests so two runtimes cannot race the same refresh session. Keep the file out of source control, static assets, chat and logs. Do not reseed credentials from an old secret on each deployment.

The importer script in `scripts/import-auth.mjs` reads only the explicit file path you supply. It sends credentials directly to your configured HTTPS office endpoint and does not print them. It requires local `BRIDGE_KEY` and `ADMIN_KEY` environment variables; those values must match the deployment secrets. Use a local private terminal to supply them.

When Cloudflare Access protects the whole origin, the importer must also pass its edge policy. Configure a machine Service Auth policy and set both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in the local private terminal. The helper forwards them as `CF-Access-Client-Id` and `CF-Access-Client-Secret`; it rejects an incomplete pair before reading the credential file. These service credentials supplement the two Worker keys and are never printed. The owner's browser uses the separate owner sign-in policy. Do not bypass Access for credential import.

```sh
cd ../cloudflare
node scripts/import-auth.mjs \
  --url https://YOUR-PRIVATE-OFFICE-HOST \
  --file /absolute/protected/path/credentials.json
```

## Prove the connection

1. Unauthenticated requests to `/`, a WebAssembly chunk and `/api/health` must fail.
2. After import, authenticated health must confirm the current account's catalog contains `gpt-6-luna`. A stored credential is not sufficient.
3. Generate one scene from the deployed runtime and require `response.completed`. Only then is live inference verified.
4. Confirm the registration, rotated credentials and host identity survive an instance restart. No reimport should be needed.

No live login or inference runs in the offline tests. A successful Cloudflare deployment, Access login or populated model catalog alone does not prove a completed Luna turn.

The test suite uses mocked Durable Object storage and network calls. It exercises real signed Access JWT verification, auth before asset dispatch, separate import authorization, durable token rotation, instance replacement, refresh/import races, request leases, quota recovery, and late streaming failures. `npm run check` builds a Wrangler deployment bundle without publishing it.

The office uses bounded, serial generation and remains an aquarium during outages. Local request budgets recover automatically; upstream quota failures expose a numeric retry delay and pause requests. A late quota error discards partial dialogue. The UI never silently switches billing or models.

## Why a Durable Object

Workers' filesystem is temporary, so `credentials.json` cannot be the cloud source of truth. SQLite Durable Object storage is private, strongly consistent and encrypted at rest. Token refresh needs explicit single-flight coordination across network awaits even inside a Durable Object. Cloudflare Containers also have ephemeral disks, so retaining the Node image would still require a storage adaptation.

Primary Cloudflare references: [filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/), [storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/), [concurrency](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [data security](https://developers.cloudflare.com/durable-objects/reference/data-security/), [private static routing](https://developers.cloudflare.com/workers/static-assets/).
