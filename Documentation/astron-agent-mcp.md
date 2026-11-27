# Astron Agent MCP Integration

> [!IMPORTANT]
> **Status: compatibility design, not a production-ready connection.** Astron Agent does not yet
> support per-server authentication headers for URL-based MCP servers. Track
> [iflytek/astron-agent#1661](https://github.com/iflytek/astron-agent/issues/1661). Until that issue
> is implemented and verified, do not expose a GitNexus MCP endpoint without authentication merely
> to make it reachable from Astron.

This guide records the protocol boundary and the safe deployment shape for connecting
[Astron Agent](https://github.com/iflytek/astron-agent) to GitNexus. It deliberately does not add an
`astron` target to `gitnexus setup`: Astron is a server/workflow platform rather than a local editor
with a user-owned stdio MCP configuration file.

## Current compatibility

| Path | Current status | Reason |
| --- | --- | --- |
| GitNexus stdio MCP | Not usable by Astron | Astron accepts URL-based Streamable HTTP or SSE servers, not local stdio commands. |
| Loopback HTTP (`127.0.0.1`, `localhost`, `::1`) | Rejected by Astron | Astron's MCP service blocks loopback URLs. In a container, loopback would refer to the Astron service itself anyway. |
| Non-loopback HTTP without authentication | Refused by GitNexus | The dedicated GitNexus HTTP MCP server refuses a non-loopback bind unless a Bearer token is configured. |
| Bearer-protected Streamable HTTP | Protocols are compatible, authentication is blocked | GitNexus expects `Authorization: Bearer <token>`; Astron's current MCP request schema has no per-server header or credential reference. |

GitNexus exposes modern Streamable HTTP at `/mcp` when started with `gitnexus mcp --http`. Astron
tries Streamable HTTP first and can fall back to legacy SSE, but a transport match is not an
authentication policy.

## Required Astron capability

Before connecting the systems, Astron needs a managed MCP credential feature that:

- stores a per-server Bearer token in secret storage rather than workflow JSON;
- attaches the header to both tool discovery and tool calls;
- redacts it from logs, traces, telemetry, errors, and API responses;
- preserves URL blacklist, loopback, redirect, and SSRF controls; and
- never forwards a credential across origins.

The acceptance contract and pinned source evidence are in
[iflytek/astron-agent#1661](https://github.com/iflytek/astron-agent/issues/1661).

## Deployment shape after the blocker is resolved

The following is an operator design, not a command sequence to use with current Astron releases.
All hostnames, namespaces, and secrets are deployment-specific.

1. Review the [PolyForm Noncommercial License 1.0.0](../LICENSE). Astron's Apache-2.0 license does
   not change GitNexus's license or grant commercial deployment rights.
2. Pin and verify an approved GitNexus release, then index the repositories locally with
   `gitnexus analyze`.
3. Load a high-entropy token from the deployment secret manager and start the **dedicated** HTTP
   MCP server in read-only mode. This POSIX-shell example intentionally has no literal token:

   ```bash
   : "${GITNEXUS_MCP_AUTH_TOKEN:?Load the token from secret storage}"
   GITNEXUS_MCP_READ_ONLY=1 \
     gitnexus mcp --http --host 0.0.0.0 --port 3000
   ```

   GitNexus will refuse this non-loopback bind if the token is absent. Read-only mode removes raw
   Cypher, rename, group routing, and other surfaces outside the proven single-repository read set.
4. Put the server behind a private, operator-managed HTTPS ingress. Route the ingress MCP URL to
   GitNexus `/mcp`; do not send the Bearer token over plaintext networks.
5. After Astron implements
   [iflytek/astron-agent#1661](https://github.com/iflytek/astron-agent/issues/1661), register the
   HTTPS `/mcp` URL and a reference to the stored credential. Do not place a token in the URL,
   workflow JSON, prompt, or tool arguments.
6. Select only the tools the workflow needs. Keep mutating GitNexus tools unavailable unless a
   separate operator-reviewed policy explicitly enables them.

## Verification checklist

Verify the complete path in a non-production environment before indexing sensitive source:

- [ ] Missing and incorrect credentials receive `401` and no tool metadata.
- [ ] The correct credential initializes Streamable HTTP and lists only the intended tools.
- [ ] `list_repos` and a bounded read query return data from the expected repository.
- [ ] `rename`, raw `cypher`, and group/mutation surfaces are absent or rejected in read-only mode.
- [ ] Repository selection is explicit when more than one index is available.
- [ ] The token is absent from Astron workflow exports, logs, traces, telemetry, and error payloads.
- [ ] Redirects cannot move the request or its credential to another origin.
- [ ] Rotating the secret does not require copying a new token into every workflow.
- [ ] Stopping GitNexus produces a visible Astron tool failure rather than a fabricated success.

## Do not use these workarounds

- Do not publish an unauthenticated `/mcp` or `/api/mcp` endpoint on a LAN or the internet.
- Do not disable Astron's loopback/SSRF checks to make a single integration pass.
- Do not encode the token in a query string, user-info URL component, prompt, or tool argument.
- Do not assume a private hostname is authentication; network location and credentials are separate
  controls.
- Do not expose the full GitNexus tool surface by default. Indexed code and graph operations can be
  sensitive even when the source repository itself is private.

## Authoritative references

- GitNexus HTTP MCP authentication and non-loopback enforcement:
  [`gitnexus/src/mcp/http-transport.ts`](../gitnexus/src/mcp/http-transport.ts)
- GitNexus server-side read-only policy:
  [`gitnexus/src/mcp/read-only-policy.ts`](../gitnexus/src/mcp/read-only-policy.ts)
- GitNexus hosted deployment security notes: [`SECURITY.md`](../SECURITY.md)
- Astron MCP transport selection:
  [`mcp_transport.py`](https://github.com/iflytek/astron-agent/blob/aaef2a286b9fb8396d42d5d4f6bb7af9b19afa22/core/plugin/link/service/community/tools/mcp/mcp_transport.py)
- Astron MCP request schema:
  [`mcp_tools_schema.py`](https://github.com/iflytek/astron-agent/blob/aaef2a286b9fb8396d42d5d4f6bb7af9b19afa22/core/plugin/link/api/schemas/community/tools/mcp/mcp_tools_schema.py)
- Astron loopback policy:
  [`access_interceptor.py`](https://github.com/iflytek/astron-agent/blob/aaef2a286b9fb8396d42d5d4f6bb7af9b19afa22/core/plugin/link/utils/security/access_interceptor.py)
