# Docker

This folder contains the Docker assets for `gitnexus-web`.

## Files

- `Dockerfile` is the source for the published `gitnexus-web` image. It builds `gitnexus-shared` and `gitnexus-web` in a Node builder stage, then copies only the compiled static site into a tiny `nginx:alpine` runtime image.
- `nginx.conf` serves the built assets and falls back to `index.html` so client-side routes keep working.
- `compose.yaml` starts the published image with Docker Compose.
- `.env.example` is an optional shell env file for the example commands below. It sets the image name, container name, and exposed port. It does not inject application config into the frontend bundle.

## Optional env file

Create a local env file if you want reusable image/container names and host port settings:

```bash
cp docker/.env.example docker/.env
set -a
source docker/.env
set +a
```

`docker/.env` is ignored by git via the repository-wide `.env` rules.

## Run with Docker

```bash
docker run --rm \
  --name "${CONTAINER_NAME:-gitnexus-web}" \
  -p "${HOST_PORT:-8080}:80" \
  "${IMAGE_NAME:-ghcr.io/abhigyanpatwari/gitnexus-web:latest}"
```

Then open `http://localhost:${HOST_PORT:-8080}`.

## Run with Docker Compose

```bash
docker compose --env-file docker/.env -f docker/compose.yaml up -d
```

If you do not want an env file, the defaults in `compose.yaml` are already set to:

```text
image: ghcr.io/abhigyanpatwari/gitnexus-web:latest
container_name: gitnexus-web
port: 8080 -> 80
```

## Notes

- The published image serves the production frontend only. It does not start `gitnexus serve`.
- In backend mode, the app still defaults to `http://localhost:4747` unless you change the server URL in the UI.
- The Dockerfile is kept here so the published image definition is versioned with the app, even if most users only need `docker run` or `docker compose`.
- For iterative frontend development, `cd gitnexus-web && npm run dev` is still the faster workflow.
