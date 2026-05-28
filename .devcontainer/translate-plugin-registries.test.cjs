// Unit tests for the devcontainer host->container config transforms.
// Pure-function coverage for the two pieces that used to live inline in
// post-create.sh heredocs (invisible to lint and untestable):
//   - plugin-registry path translation (buildRe + rewriteDeep), which has
//     had path-handling bugs before
//   - the $HOME/.claude.json machine-field strip (sanitizeClaudeConfig)
//
// Run with the built-in Node test runner (no deps):
//   node --test .devcontainer/

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRe,
  rewriteDeep,
} = require("./translate-plugin-registries.cjs");
const { sanitizeClaudeConfig } = require("./seed-claude-config.cjs");

const CLAUDE = "/home/node/.claude/plugins";
const CURSOR = "/home/node/.cursor/plugins";

function rw(value, cli, ctr) {
  return rewriteDeep(value, buildRe(cli), ctr);
}

test("claude: Windows backslash absolute path -> container path", () => {
  assert.equal(
    rw("C:\\Users\\gergo\\.claude\\plugins\\cache\\x\\1.0", "claude", CLAUDE),
    "/home/node/.claude/plugins/cache/x/1.0",
  );
});

test("claude: Windows forward-slash absolute path -> container path", () => {
  assert.equal(
    rw("C:/Users/gergo/.claude/plugins/marketplaces/m", "claude", CLAUDE),
    "/home/node/.claude/plugins/marketplaces/m",
  );
});

test("claude: macOS POSIX path -> container path", () => {
  assert.equal(
    rw("/Users/alice/.claude/plugins/marketplaces/m", "claude", CLAUDE),
    "/home/node/.claude/plugins/marketplaces/m",
  );
});

test("claude: Linux POSIX path -> container path", () => {
  assert.equal(
    rw("/home/bob/.claude/plugins/cache/foo", "claude", CLAUDE),
    "/home/node/.claude/plugins/cache/foo",
  );
});

test("cursor: Windows path -> container cursor path", () => {
  assert.equal(
    rw("C:\\Users\\gergo\\.cursor\\plugins\\local\\myplug", "cursor", CURSOR),
    "/home/node/.cursor/plugins/local/myplug",
  );
});

test("cross-CLI isolation: claude regex leaves a .cursor path untouched", () => {
  const input = "C:\\Users\\g\\.cursor\\plugins\\x";
  assert.equal(rw(input, "claude", CLAUDE), input);
});

test("non-path strings pass through unchanged", () => {
  assert.equal(rw("not-a-path", "claude", CLAUDE), "not-a-path");
  assert.equal(rw("https://github.com/EveryInc/x.git", "claude", CLAUDE), "https://github.com/EveryInc/x.git");
});

test("non-string scalars pass through unchanged", () => {
  assert.equal(rw(42, "claude", CLAUDE), 42);
  assert.equal(rw(null, "claude", CLAUDE), null);
  assert.equal(rw(true, "claude", CLAUDE), true);
});

test("nested objects/arrays are rewritten deeply", () => {
  const input = {
    "compound-engineering@m": [
      { installPath: "C:\\Users\\g\\.claude\\plugins\\cache\\ce\\3.9.2", version: "3.9.2" },
    ],
    nested: { installLocation: "/Users/g/.claude/plugins/marketplaces/m" },
  };
  const out = rw(input, "claude", CLAUDE);
  assert.equal(
    out["compound-engineering@m"][0].installPath,
    "/home/node/.claude/plugins/cache/ce/3.9.2",
  );
  assert.equal(out["compound-engineering@m"][0].version, "3.9.2");
  assert.equal(
    out.nested.installLocation,
    "/home/node/.claude/plugins/marketplaces/m",
  );
});

test("sanitizeClaudeConfig: strips machine fields, forces hasCompletedOnboarding", () => {
  const out = sanitizeClaudeConfig({
    installMethod: "native",
    autoUpdates: false,
    autoUpdatesProtectedForNative: true,
    shiftEnterKeyBindingInstalled: true,
    userID: "abc",
    oauthAccount: { emailAddress: "x@y.z" },
  });
  assert.equal(out.installMethod, undefined);
  assert.equal(out.autoUpdates, undefined);
  assert.equal(out.autoUpdatesProtectedForNative, undefined);
  assert.equal(out.shiftEnterKeyBindingInstalled, undefined);
  assert.equal(out.userID, "abc");
  assert.equal(out.oauthAccount.emailAddress, "x@y.z");
  assert.equal(out.hasCompletedOnboarding, true);
});

test("sanitizeClaudeConfig: non-object inputs become a valid onboarding-bearing object", () => {
  for (const bad of [42, "x", null, ["a"], true]) {
    const out = sanitizeClaudeConfig(bad);
    assert.equal(typeof out, "object");
    assert.equal(Array.isArray(out), false);
    assert.equal(out.hasCompletedOnboarding, true);
  }
});

test("sanitizeClaudeConfig: empty object still gets hasCompletedOnboarding", () => {
  assert.deepEqual(sanitizeClaudeConfig({}), { hasCompletedOnboarding: true });
});
