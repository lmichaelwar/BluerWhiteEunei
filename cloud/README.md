# Eunnei cloud bridge

Small, dependency-free Node bridge for Aphae's office aquarium. It translates the existing Ollama chat contract into OpenAI Responses requests using **ChatGPT plan usage through Sign in with ChatGPT**. Default model: `gpt-6-luna`. It never reads Codex's credentials or an API key and has no paid API fallback.

Local consent, Cloudflare credential import, Luna model access, and a completed Luna response were verified on 2026-10-24. The test suite uses synthetic credentials. A stored credential alone does not make the office show as connected.

## Hosting decision and eligibility

Use one personal cloud VM for the Node bridge and the Godot web export, under the same private HTTPS origin. That avoids browser credential/CORS friction and leaves the laptop off after initial consent. No VM has been provisioned by this project.

OpenAI documents a self-hosted VM procedure for an open-source app: perform OAuth locally, transfer the protected session over SSH, keep a distinct VM host ID, and let the VM own subsequent refreshes. The broader docs say paid or remotely hosted app offerings need the interest form. This is **not** evidence that any private Cloudflare Worker or Sites backend automatically qualifies. Sites' normal identity sign-in also does not supply plan-usage permission.

This bridge's original code is MIT licensed. That does not relicense Aphae or its assets, nor establish that the combined app is eligible. Confirm the registration and plan-usage consent are available before treating this deployment route as live. If unavailable, leave the office disconnected; do not substitute an API key or reuse a native Codex session.

Official references:

- [Plan usage overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## Run without connecting an account

Requires Node 22 or newer; no npm install is needed.

```sh
npm test
npm start
```

The server listens at `http://127.0.0.1:8787`. Health reports `auth_required` until separately authorized. Put the Godot web export in `static/`, or point `EUNNEI_STATIC_DIR` to the repo's `build/site` directory. Missing exports return an explanatory 404. The bridge supplies `.wasm` and `.pck` MIME types and Godot's cross-origin isolation headers.

## Connect the plan once, locally

Run this on the computer whose browser you will use. The documented callback is HTTP loopback; do not replace it with a remote website callback.

```sh
npm run auth
```

The helper prints and opens a local page at `http://127.0.0.1:1455/` with a **Continue with ChatGPT** button. If no window appears, open that address manually in a browser on the same computer. Running the helper through SSH does not guarantee a visible browser window. The page expires after ten minutes; restart the helper if it expires.

It generates fresh state, nonce and PKCE; performs dynamic registration; validates the signed ID token, issuer, audience, nonce, expiry and granted plan scope; then saves owner-only credentials in `~/.config/eunnei/credentials.json`. It does not run inference. Override the protected directory with `EUNNEI_DATA_DIR`; override the local callback port with `EUNNEI_AUTH_PORT` if 1455 is occupied.

On Windows, set `EUNNEI_DATA_DIR` inside a directory whose DACL restricts access to your account and SYSTEM. Unix file-mode checks do not establish Windows access permissions.

Use an SSH channel to transfer **only this helper's credential record** to the personal VM. Keep it outside the repository, image build context, static files, logs and chat. Do not transfer the laptop's `host.json`. On the VM, import it:

```sh
EUNNEI_DATA_DIR=/secure/eunnei npm run import-auth -- /secure/incoming/credentials.json
```

The importer creates or preserves a distinct VM host ID. The VM now owns this rotating refresh session: do not also run a local bridge against the copied session. Remove the temporary transfer copy after confirming import. The app stores tokens in a 0700 directory and atomically replaces its 0600 credential file; storage is not encrypted at rest, so use a protected VM disk/secret volume.

## Run privately on the VM

For the integrated repository, from its `cloud/` directory:

```sh
EUNNEI_DATA_DIR=/secure/eunnei EUNNEI_STATIC_DIR=../build/site npm start
```

This binds loopback. Use a private HTTPS reverse proxy or an SSH tunnel to reach it. If binding a network interface, set `HOST=0.0.0.0` and an `APP_PASSWORD` of at least 24 characters. The server rejects a network bind with an absent or short password. Use `APP_USERNAME` (default `michael`) and that password for the browser's Basic authentication prompt. Basic authentication requires HTTPS outside loopback; keep port 8787 off the public firewall.

Docker is optional. Build from this directory; mount the exported site and a persistent secret volume rather than baking either credentials or Aphae assets into the image:

```sh
docker build -t eunnei-bridge .
docker volume create eunnei-data
docker run --rm \
  --mount source=eunnei-data,target=/data \
  --mount type=bind,src=/secure/incoming,target=/import,readonly \
  eunnei-bridge node src/import-auth.mjs /import/credentials.json
docker run -d --name eunnei --restart unless-stopped \
  --env-file /secure/eunnei.env \
  -p 127.0.0.1:8787:8787 \
  --mount source=eunnei-data,target=/data \
  --mount type=bind,src=/absolute/repo/build/site,target=/app/static,readonly \
  eunnei-bridge
```

The env file must contain a long private `APP_PASSWORD`; protect it with mode 0600. The image runs as the `node` user (UID 1000). Ensure transferred files are readable by that user and no one else. A Docker volume retains the VM host identity and refresh tokens between restarts. Use only one bridge process/replica per credential volume.

A separate private Sites preview can use `EUNNEI_ALLOWED_ORIGIN=https://exact-private-site-origin` and authenticated requests. CORS is denied by default and accepts only this exact configured origin. This is an optional preview connection; the same-origin VM version is the simplest working setup. Never put OpenAI tokens in the browser or a Site asset. The private bridge password is separate from ChatGPT credentials.

## Contract and runtime limits

| Endpoint | Behavior |
| --- | --- |
| `GET /api/health` | `{available, model, status, error, retry_after, credential_present, verified_inference}`. Fetches the current account's model catalog and caches it for five minutes. `available:true` requires Luna in that catalog. `model_verified` means no completed inference yet; `ready` means at least one completed response this process. |
| `POST /api/chat` | Accepts `{messages,format,options,model,stream:false}`; returns Ollama `{message:{role:"assistant",content:"JSON text"},done:true,...}`. The server's configured model wins. A JSON schema in `format` is included in the instructions. |
| `GET /api/models` | Verified account model catalog, cached. No inference. |
| `GET /api/tags` | Compatibility catalog with the configured model; not proof of access. |
| `POST /api/resume` | Clears an authentication block after reconnecting; cannot bypass an active quota cooldown or local request budget. |

All endpoints and static assets require the private password if one is configured. API clients may use Basic authentication or `Authorization: Bearer <private bridge password>`.

Default bounds are **one concurrent inference, six requests per rolling minute, and sixty per rolling hour**. Configure `EUNNEI_REQUESTS_PER_MINUTE` (1–60) and `EUNNEI_REQUESTS_PER_HOUR` (1–3600). Rate limits return HTTP 429, numeric `retry_after`, and a `Retry-After` header; local budgets recover automatically. Upstream quota failures respect the supplied cooldown (15 seconds to 24 hours; five minutes when absent). The server does not retry quota failures. Health polling during a cooldown does not call the model provider.

Only HTTP 401 gets one token refresh and one retry, using the same entitlement. Access tokens are refreshed before expiry; concurrent refreshes share a single rotation. There is no retry after partial generation, quota failure or timeout. The request deadline is forty seconds, inside the Godot client's forty-five-second timeout. Counters/cooldowns are process memory and reset on restart; this is a single-user bridge, not a distributed quota service.

OpenAI SSE is buffered until `response.completed`. A late `response.failed`, incomplete stream or quota failure discards partial dialogue. Ollama's `temperature`, `top_p`, output-token controls and system-role messages are not forwarded: this plan-usage route restricts those parameters. System prompts become `instructions`, and surreal variation must come from story prompts/state. JSON-schema output here is prompt constrained, so the Godot client still validates it before committing a scene.

## Verify a real connection

After consent and import, open the private office. Health should move from `auth_required` to `model_verified`; this confirms account/model access without claiming live generation. Generate one scene and require a complete response before showing it as live. `verified_inference:true` and `status:ready` record that proof for this process. On quota exhaustion, preserve the aquarium and back off; on revoked/expired consent, reconnect and resume. Check ChatGPT's usage settings to inspect or revoke the app's plan access.

The mocked suite covers OAuth validation, token permissions and atomic rotation, catalog-backed health, incompatible-field/schema translation, SSE completion and late quota failures, private HTTP auth, CORS rejection, retry limits, and automatic quota recovery. No live login or inference is part of `npm test`.
