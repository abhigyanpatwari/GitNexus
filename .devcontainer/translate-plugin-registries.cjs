// Rewrites the host paths inside Claude and Cursor plugin-registry JSON files
// so they point at the container's Linux paths, then writes the results into
// the named volume.
//
// Why: both CLIs store absolute, OS-native install paths in their registry
// JSONs. On Windows that looks like `C:\Users\X\.claude\plugins\...`; on macOS
// like `/Users/X/.cursor/...`. The Linux container can't use those paths. If we
// just bind-mounted the host files in, the CLI would try to resolve a Windows
// path under Linux and fail with `cache-miss`. So for each CLI we read the host
// registry, rewrite every absolute path ending in `/.<cli>/plugins/<rest>` to
// `/home/node/.<cli>/plugins/<rest>`, and write the result into the named volume.
//
// Codex is left alone. Its registry is config.toml and holds git URLs, not
// filesystem paths, so there's nothing to translate — its whole plugins/ dir is
// copied as-is into the container volume instead (seeded once by post-create.sh).
//
// This code lived inside a post-create.sh heredoc. We pulled it out so the regex
// and the deep rewrite can be unit-tested and prettier-checked. The regex has
// had path-handling bugs before.

'use strict';

const fs = require('fs');
const path = require('path');

// Build a regex that matches an absolute path containing
// `<sep>.<cli><sep>plugins<sep><rest>`, where <sep> is `/` or `\`. It's anchored
// at the start of the string. The lazy `.*?` eats the home prefix up to the
// FIRST `.<cli>/plugins` segment.
function buildRe(cliName) {
  return new RegExp(`^(?:[A-Za-z]:)?[\\\\/].*?[\\\\/]\\.${cliName}[\\\\/]plugins[\\\\/](.*)$`);
}

// Walk `obj` and rewrite every string value that matches `re`. A match is
// remapped under `ctr`, the container's plugins dir. Windows backslashes in the
// matched part are switched to forward slashes.
function rewriteDeep(obj, re, ctr) {
  if (Array.isArray(obj)) return obj.map((v) => rewriteDeep(v, re, ctr));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = rewriteDeep(v, re, ctr);
    return out;
  }
  if (typeof obj === 'string') {
    return obj.replace(re, (_, rest) => `${ctr}/${rest.replace(/\\/g, '/')}`);
  }
  return obj;
}

const REGISTRIES = [
  {
    cli: 'claude',
    host: '/host/.claude/plugins',
    ctr: '/home/node/.claude/plugins',
    files: ['known_marketplaces.json', 'installed_plugins.json', 'plugin-catalog-cache.json'],
  },
  {
    cli: 'cursor',
    host: '/host/.cursor/plugins',
    ctr: '/home/node/.cursor/plugins',
    files: ['installed_plugins.json'],
  },
];

function translate(registries) {
  for (const reg of registries) {
    const re = buildRe(reg.cli);
    try {
      fs.mkdirSync(reg.ctr, { recursive: true });
    } catch (err) {
      console.error(`[post-create] ERROR: failed to create ${reg.ctr}: ${err && err.message}`);
      process.exit(1);
    }
    for (const name of reg.files) {
      const src = path.join(reg.host, name);
      const dst = path.join(reg.ctr, name);
      if (!fs.existsSync(src) || fs.statSync(src).size === 0) continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(src, 'utf8'));
      } catch {
        continue; // Skip a malformed host registry instead of aborting.
      }
      try {
        fs.writeFileSync(dst, JSON.stringify(rewriteDeep(data, re, reg.ctr), null, 2));
      } catch (err) {
        console.error(`[post-create] ERROR: failed to write ${dst}: ${err && err.message}`);
        process.exit(1);
      }
    }
  }
}

// Filter the registry table by CLI name. post-create.sh passes the CLIs it is
// seeding this run (e.g. `claude`), so a registry is only (re)generated on the
// FIRST container-create for that CLI — never on a rebuild, where it would
// clobber a plugin the user installed inside the container. An empty filter
// (no args) means "translate every registry" — the original behavior.
function selectRegistries(registries, only) {
  return only && only.length ? registries.filter((r) => only.includes(r.cli)) : registries;
}

module.exports = { buildRe, rewriteDeep, REGISTRIES, translate, selectRegistries };

if (require.main === module) {
  translate(selectRegistries(REGISTRIES, process.argv.slice(2)));
}
