// Seeds the container's $HOME/.claude.json from the host's copy — but NOT
// verbatim. ~/.claude.json mixes portable ACCOUNT/ONBOARDING state
// (hasCompletedOnboarding, oauthAccount, userID, projects, tipsHistory — keep)
// with HOST BINARY-MANAGEMENT state that is never valid in this container:
// the image installs Claude via `npm install -g`, but the host's
// `installMethod` (e.g. "native") makes Claude expect/probe ~/.local/bin/claude
// and fail with "claude command not found at /home/node/.local/bin/claude". So
// we DROP the install/machine fields and let the npm-global binary auto-detect
// its own method, and force hasCompletedOnboarding so the wizard is skipped
// even on a first-time host.
//
// Extracted from a post-create.sh heredoc so the pure transform is unit-tested
// and prettier-checked (see seed-claude-config.test via translate-plugin-registries
// test harness). DISABLE_AUTOUPDATER=1 (containerEnv) already neutralizes
// runtime updates; this purely silences the doctor mismatch + native probe.

'use strict';

const fs = require('fs');

// Host binary-management / machine-install fields — never valid for an
// `npm install -g` container. Stripping lets Claude auto-detect npm-global.
const MACHINE_FIELDS = [
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'shiftEnterKeyBindingInstalled',
];

// Pure transform: take whatever the host file parsed to and return the
// container-appropriate config object. Defends against a host file that is
// valid JSON but not an object (a bare number/string/array would otherwise
// slip the parse try/catch, no-op the field deletes, silently fail the
// hasCompletedOnboarding assignment, and re-trigger onboarding every rebuild).
function sanitizeClaudeConfig(parsed) {
  let cfg = parsed;
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    cfg = {};
  }
  for (const k of MACHINE_FIELDS) {
    delete cfg[k];
  }
  cfg.hasCompletedOnboarding = true; // skip the wizard even on a first-time host
  return cfg;
}

function readHostConfig(src) {
  try {
    if (fs.existsSync(src) && fs.statSync(src).size > 0) {
      return JSON.parse(fs.readFileSync(src, 'utf8'));
    }
  } catch {
    // Malformed/unreadable host file — fall back to an empty config so the
    // container still gets a valid hasCompletedOnboarding-bearing file.
  }
  return {};
}

function main() {
  const src = process.argv[2] || '/host/.claude.json';
  const dst = process.argv[3] || '/home/node/.claude.json';
  const cfg = sanitizeClaudeConfig(readHostConfig(src));
  try {
    fs.writeFileSync(dst, JSON.stringify(cfg, null, 2));
    fs.chmodSync(dst, 0o644);
  } catch (err) {
    console.error(`[post-create] ERROR: failed to seed ${dst}: ${err && err.message}`);
    process.exit(1);
  }
}

module.exports = { sanitizeClaudeConfig, readHostConfig, MACHINE_FIELDS };

if (require.main === module) {
  main();
}
