# Deployment

[Back to GitNexus](../README.md)

## Deploy to Render

Deploy GitNexus in one click:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/abhigyanpatwari/GitNexus)

The Blueprint creates two services. `gitnexus-server` runs `gitnexus serve` as a private service: no public URL, reachable only over Render's private network, with a persistent disk for indexes and cloned repos. `gitnexus-web` is the public one. It serves the UI and reverse-proxies `/api/*` to the server, so the browser talks to a single origin.

At the Blueprint's defaults this runs about **$35/month**: $25 for the server's `standard` instance, $7 for the web service's `starter` instance, and $2.50 for the 10 GB disk. See [Render's pricing](https://render.com/pricing) for other plans.

The deploy generates an access token, and the UI asks for it on first use:

1. Open the `gitnexus-web` service in your [Render dashboard](https://dashboard.render.com/).
2. Copy `GITNEXUS_SERVE_AUTH_TOKEN` from its **Environment** tab.
3. Load the site and paste the token into the prompt (or the settings panel).

Every `/api/*` request carries that token as a header, and the proxy answers `401` without it. The browser keeps it in `sessionStorage`, so a new tab asks again. To rotate it, edit the environment variable and redeploy.

The proxy strips `Origin` before forwarding, so the server's CSRF guard does nothing for proxied traffic; it passes `Origin`-less requests through by design. The token is the only control on this deploy, not a second layer behind the guard. Anyone holding it can read every indexed repo. See [SECURITY.md](../SECURITY.md#hosted-deploys-on-render).

Indexing is memory-bound. If `gitnexus-server` runs out of memory on a large repo, raise its `plan`, which sets available RAM: `standard` is 2 GB, `pro` is 4 GB. Raise `sizeGB` only if the disk fills with clones and indexes.

## Deploy to RepoCloud

[![Deploy on RepoCloud](https://d16t0pc4846x52.cloudfront.net/deploylobe.svg)](https://repocloud.io/details/gitnexus/)

## Docker

Run Compose commands from the repository root.

```bash
docker compose up -d
```

This starts the server on `http://localhost:4747` and the web UI on `http://localhost:4173`. The UI auto-detects the server because the browser runs on the host and reaches the container via the mapped port.

The official setup ships **two signed images**, published identically to **GitHub Container Registry** (GHCR) and **Docker Hub** — same build, same digest, same Cosign signature:

| Purpose                                                                | GHCR (default in `docker-compose.yaml`)       | Docker Hub mirror              |
| ---------------------------------------------------------------------- | --------------------------------------------- | ------------------------------ |
| CLI / `gitnexus serve` backend (HTTP API on port `4747`, MCP, indexer) | `ghcr.io/abhigyanpatwari/gitnexus:latest`     | `akonlabs/gitnexus:latest`     |
| Static web UI (port `4173`)                                            | `ghcr.io/abhigyanpatwari/gitnexus-web:latest` | `akonlabs/gitnexus-web:latest` |

A named volume (`gitnexus-data`) persists the global registry, indexes, and cloned repos at `/data/gitnexus` inside the server container. To make repos on your host machine indexable, set `WORKSPACE_DIR` before bringing the stack up:

```bash
WORKSPACE_DIR=$HOME/code docker compose up -d
# Inside the server container the directory is mounted read-only at /workspace.
docker compose exec gitnexus-server gitnexus index /workspace/my-repo
```

> **Heads-up — image rename.** Earlier releases published the web UI under `ghcr.io/abhigyanpatwari/gitnexus`. That slug now hosts the CLI/server image and the UI moved to `ghcr.io/abhigyanpatwari/gitnexus-web`. Previous tags remain pullable, but new versions are only published under the new slugs — update your `docker run` / compose files (or just adopt the bundled compose).

## Direct docker run & env file

```bash
# Server
docker run --rm -d \
  --name gitnexus-server \
  -p 4747:4747 \
  -v gitnexus-data:/data/gitnexus \
  ghcr.io/abhigyanpatwari/gitnexus:latest

# Web UI
docker run --rm -d \
  --name gitnexus-web \
  -p 4173:4173 \
  ghcr.io/abhigyanpatwari/gitnexus-web:latest
```

Optional env file (override image tags, container names, ports, workspace dir):

```bash
cp .env.example .env
docker compose --env-file .env up -d
```

<details>
<summary><strong>Same-origin API behind a reverse proxy</strong></summary>

`GITNEXUS_BACKEND_URL` is normally an absolute URL, which ties the UI to one API hostname. Set it to `/` instead and the browser calls the API on the origin that served the page — so one `gitnexus-web` container can be reached on several hostnames (an internal `*.localhost` name and a public one, say) as long as `/api/*` is served next to the UI on each of them. A path such as `/gitnexus` works the same way for an API mounted under a prefix.

`/api/*` goes through the web container's own proxy: give `gitnexus-web` `GITNEXUS_UPSTREAM_URL=http://gitnexus-server:4747` and a `GITNEXUS_SERVE_AUTH_TOKEN`; it forwards `/api/*` to the server and ends the browser origin there, so the server's CORS allowlist never sees the public hostnames. The UI asks for the token once. With Traefik, one router for the whole UI is enough:

```yaml
services:
  gitnexus-web:
    environment:
      - GITNEXUS_BACKEND_URL=/
      - GITNEXUS_UPSTREAM_URL=http://gitnexus-server:4747
      - GITNEXUS_SERVE_AUTH_TOKEN=${GITNEXUS_SERVE_AUTH_TOKEN}
    labels:
      - traefik.http.routers.gitnexus.rule=Host(`gitnexus.example.com`) || Host(`gitnexus.localhost`)
      - traefik.http.services.gitnexus.loadbalancer.server.port=4173
```

Routing `/api/*` straight to `gitnexus serve` on a public hostname is not supported: `serve` has no authentication of its own yet, and it refuses to start with `GITNEXUS_PUBLIC_ORIGIN` set until it does. Reach it through the proxy above.

</details>

Files:

- [Dockerfile.web](../Dockerfile.web) — builds `gitnexus-shared` and `gitnexus-web`, then serves the production frontend.
- [Dockerfile.cli](../Dockerfile.cli) — builds the CLI/server (with its native deps) and runs `gitnexus serve --host 0.0.0.0`. Local embeddings are **not** in the image (`onnxruntime-node` is opt-in; runtime npm is stripped). Bind-mount a prefix or set `GITNEXUS_EMBEDDING_URL`.
- [docker-compose.yaml](../docker-compose.yaml) — starts both signed images side by side.
- [.env.example](../.env.example) — overrides for image names, container names, ports, and the workspace mount.

## Versioning & supply-chain protection (Cosign signatures, provenance, Kubernetes admission policy)

The Docker images are version-locked to the npm package:

- Stable images are **only published from `vX.Y.Z` git tags** (via `docker.yml` triggered directly by the tag push), and the workflow refuses to build unless the tag exactly matches `gitnexus/package.json`'s version. So `ghcr.io/abhigyanpatwari/gitnexus:1.6.2` (and its Docker Hub mirror `akonlabs/gitnexus:1.6.2`) is byte-for-byte the same release as `npm install gitnexus@1.6.2` — no drift, no floating builds from `main`. Both registries receive the same digest from a single build step, so you can pull from either and the signature verifies identically.
- Release-candidate images (e.g. `:1.7.0-rc.1`) are published alongside each RC npm release. They are built by `publish.yml` calling `docker.yml` as a reusable workflow after the RC tag is created and pushed.
- `:latest` is auto-promoted only from non-prerelease tags by the Docker metadata action, so it always points at a real, npm-published version.

Both images are signed with [Cosign keyless signing][cosign-keyless] using the workflow's GitHub OIDC identity, and shipped with build provenance and SBOM attestations. **This is your protection against supply-chain attacks**: even if an attacker republishes a same-named image elsewhere (or somehow pushes to a typo-squatted registry), they cannot forge a Cosign signature tied to `abhigyanpatwari/GitNexus`'s `docker.yml`. Always verify before pulling into sensitive environments.

**Stable releases** — signed from the `v*` tag ref:

```bash
cosign verify ghcr.io/abhigyanpatwari/gitnexus:1.6.2 \
  --certificate-identity-regexp '^https://github\.com/abhigyanpatwari/GitNexus/\.github/workflows/docker\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# Same signature verifies the Docker Hub mirror (identical digest):
cosign verify docker.io/akonlabs/gitnexus:1.6.2 \
  --certificate-identity-regexp '^https://github\.com/abhigyanpatwari/GitNexus/\.github/workflows/docker\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The regex pins the certificate identity to this repo's `docker.yml` workflow **run from a `v*` tag** — rejecting unsigned images, images signed by other workflows, and images signed from unprotected refs. It is identical for both registries because both sets of tags were signed at the same digest in one workflow run.

**Release candidates** — signed from `refs/heads/main` (the caller's ref when `publish.yml` invokes `docker.yml` as a reusable workflow):

```bash
cosign verify ghcr.io/abhigyanpatwari/gitnexus:1.7.0-rc.1 \
  --certificate-identity 'https://github.com/abhigyanpatwari/GitNexus/.github/workflows/docker.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

You can also inspect the build provenance and SBOM:

```bash
cosign download attestation ghcr.io/abhigyanpatwari/gitnexus:1.6.2 \
  --predicate-type https://slsa.dev/provenance/v1
```

**Kubernetes: enforce signatures at admission.** Ship the bundled [`ClusterImagePolicy`](../deploy/kubernetes/cluster-image-policy.yaml) so the [Sigstore policy-controller][policy-controller] rejects any GitNexus pod whose image is not signed by this repo's `docker.yml` running from a `vX.Y.Z` tag — the same identity the `cosign verify` snippet above pins.

```bash
# 1. Install the controller (one-time, cluster-wide)
helm repo add sigstore https://sigstore.github.io/helm-charts && helm repo update
helm install policy-controller -n cosign-system --create-namespace \
  sigstore/policy-controller

# 2. Opt your namespace in
kubectl label namespace <your-ns> policy.sigstore.dev/include=true

# 3. Apply the policy
kubectl apply -f deploy/kubernetes/cluster-image-policy.yaml
```

After this, attempting to deploy an unsigned image — or one signed by anything other than `abhigyanpatwari/GitNexus`'s `docker.yml` at a `v*` tag — fails the admission webhook before a pod is ever created. This turns the verifiable signature into an enforced policy, which is the supply-chain control most clusters actually need.

[cosign-keyless]: https://docs.sigstore.dev/cosign/signing/overview/
[policy-controller]: https://docs.sigstore.dev/policy-controller/overview/

## Run the frontend locally

```bash
git clone https://github.com/abhigyanpatwari/gitnexus.git
cd gitnexus/gitnexus-web && npm install
# Compile sibling gitnexus-shared with this package's TypeScript 7 (do not npm ci shared).
cd ../gitnexus-shared && node ../gitnexus-web/node_modules/typescript/lib/tsc.js
cd ../gitnexus-web && npm run dev
# Then in another terminal, start the backend the frontend connects to:
npx gitnexus@latest serve
```
