// Builds the container's $HOME/.claude.json from the host's copy. It does NOT
// copy the host file verbatim. The host's ~/.claude.json holds two kinds of
// data. Some is portable account and onboarding state: hasCompletedOnboarding,
// oauthAccount, userID, projects, tipsHistory. We keep that. The rest tracks
// how Claude was installed on the host machine, and that is never right inside
// this container.
//
// Here is why the install fields break things. The image installs Claude with
// `npm install -g`. But if the host's `installMethod` says something like
// "native", Claude looks for ~/.local/bin/claude and fails with
// "claude command not found at /home/node/.local/bin/claude". So we drop the
// install and machine fields. With them gone, the npm-global binary detects its
// own install method. We also force hasCompletedOnboarding so the setup wizard
// is skipped, even when the host has never run Claude before.
//
// This logic was pulled out of a heredoc in post-create.sh. As its own file the
// transform can be unit-tested and prettier-checked (see seed-claude-config.test
// via the translate-plugin-registries test harness). DISABLE_AUTOUPDATER=1 in
// containerEnv already stops runtime updates. This file only quiets the doctor
// mismatch and the native-path probe.

'use strict';

const fs = require('fs');

// Fields that describe how Claude was installed on the host machine. They are
// never valid in an `npm install -g` container. Removing them lets Claude
// detect the npm-global install on its own.
const MACHINE_FIELDS = [
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'shiftEnterKeyBindingInstalled',
];

// Pure transform: take whatever the host file parsed to and return a config
// object suitable for the container. It also guards against a host file that is
// valid JSON but not an object. A bare number, string, or array would pass the
// parse try/catch. Then the field deletes would do nothing, the
// hasCompletedOnboarding assignment would silently fail, and onboarding would
// trigger again on every rebuild. The guard replaces such a value with {}.
function sanitizeClaudeConfig(parsed) {
  let cfg = parsed;
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    cfg = {};
  }
  for (const k of MACHINE_FIELDS) {
    delete cfg[k];
  }
  cfg.hasCompletedOnboarding = true; // skip the wizard, even on a first-time host
  return cfg;
}

function readHostConfig(src) {
  try {
    if (fs.existsSync(src) && fs.statSync(src).size > 0) {
      return JSON.parse(fs.readFileSync(src, 'utf8'));
    }
  } catch {
    // Host file is malformed or unreadable. Fall back to an empty config so the
    // container still gets a valid file that carries hasCompletedOnboarding.
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
