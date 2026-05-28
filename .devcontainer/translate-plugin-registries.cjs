// Translates Claude + Cursor plugin-registry JSON files from host absolute
// paths to the container's Linux paths, then writes them into the named
// volume. Both CLIs bake absolute OS-native install paths into their registry
// JSONs — `C:\Users\X\.claude\plugins\...` on Windows, `/Users/X/.cursor/...`
// on macOS — so the host versions can't be bind-mounted into the Linux
// container (the CLI fails with `cache-miss` resolving a Windows path under
// Linux). For each CLI we read the host registry, rewrite every absolute path
// ending in `/.<cli>/plugins/<rest>` to `/home/node/.<cli>/plugins/<rest>`,
// and write the result into the named volume. (Codex needs no translation —
// its enablement registry is config.toml with git URLs, not filesystem paths,
// so its whole plugins/ dir is bind-mounted instead.)
//
// Extracted from a post-create.sh heredoc so the regex + deep rewrite are
// lintable and unit-tested (the regex has had path-handling bugs before).

'use strict';

const fs = require('fs');
const path = require('path');

// Match an absolute path that contains `<sep>.<cli><sep>plugins<sep><rest>`
// where <sep> is `/` or `\`. Anchored at start; the lazy `.*?` consumes the
// home prefix up to the FIRST `.<cli>/plugins` segment.
function buildRe(cliName) {
  return new RegExp(`^(?:[A-Za-z]:)?[\\\\/].*?[\\\\/]\\.${cliName}[\\\\/]plugins[\\\\/](.*)$`);
}

// Recursively rewrite every string value in `obj` that matches `re`,
// remapping it under `ctr` (the container plugins dir) and normalizing
// Windows backslashes to forward slashes.
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
        continue; // skip a malformed host registry rather than abort
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

module.exports = { buildRe, rewriteDeep, REGISTRIES, translate };

if (require.main === module) {
  translate(REGISTRIES);
}
