#!/usr/bin/env node
/**
 * GitNexus Cursor postToolUse Hook
 *
 * Receives a JSON event on stdin describing a finished tool call, derives a
 * search pattern (Grep query, Read file basename, or rg/grep arg from a Shell
 * command), runs `gitnexus augment <pattern>`, and emits the enriched context
 * back as `{ additional_context: "..." }` so the agent sees it alongside the
 * tool result.
 *
 * Replaces the legacy beforeShellExecution / augment-shell.sh pipeline:
 *   - Cross-platform (no bash, no jq — runs on Windows out of the box)
 *   - Covers Read and Grep, not just Shell rg/grep
 *
 * Cursor 2.4+ generic hooks: https://cursor.com/docs/agent/hooks
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquireHookSlot } = require('./hook-lock.cjs');
const { resolveHookRepo } = require('./registry-query.cjs');

function readInput() {
  try {
    const data = fs.readFileSync(0, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function tokenizeShellWords(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  let hasToken = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      hasToken = true;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      hasToken = true;
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\') {
        const next = command[index + 1];
        if (next === '$' || next === '`' || next === '"' || next === '\\') {
          escaped = true;
        } else {
          current += '\\';
        }
      } else {
        current += char;
      }
      hasToken = true;
      continue;
    }

    if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined || /\s/.test(next) || next === "'" || next === '"' || next === '\\') {
        escaped = true;
      } else {
        current += '\\' + next;
        index += 1;
      }
      hasToken = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
    } else if (char === ';' || char === '|' || char === '&') {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
      const next = command[index + 1];
      if ((char === '|' || char === '&') && next === char) {
        tokens.push(char + char);
        index += 1;
      } else {
        tokens.push(char);
      }
    } else {
      current += char;
      hasToken = true;
    }
  }

  if (escaped) current += '\\';
  if (hasToken) tokens.push(current);
  return tokens;
}

function parseRgGrepPattern(cmd) {
  const tokens = tokenizeShellWords(cmd);
  let foundCmd = false;
  let skipNext = false;
  let skipNextAsPattern = false;
  let endOfOptions = false;
  let explicitPatternSeen = false;
  let patternFileSeen = false;
  const flagsWithValues = new Set([
    '-e',
    '-f',
    '--file',
    '-m',
    '--max-count',
    '-A',
    '-B',
    '-C',
    '-g',
    '--glob',
    '--iglob',
    '-t',
    '--type',
    '--include',
    '--exclude',
    '--encoding',
    '--path',
  ]);
  const rgValueFlags = new Set(['-r', '--replace']);
  const patternFlags = new Set(['-e', '--regexp']);
  const connectors = new Set(['&&', '||', ';', '|', '&']);
  const wrappers = new Set([
    'npx',
    'bunx',
    'pnpm',
    'yarn',
    'npm',
    'sudo',
    'env',
    'command',
    'time',
    'nice',
    'xargs',
    'dlx',
    'exec',
    'run',
    'git',
  ]);
  const wrapperFlagsWithValues = new Set([
    '--package',
    '-p',
    '--call',
    '--prefix',
    '--shell',
    '--filter',
    '--workspace',
    '--dir',
    '--cwd',
  ]);
  const basename = (token) =>
    token
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(exe|cmd|bat)$/i, '');

  let previousToken;
  let seenWrapper = false;
  let searchCommand = null;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      if (skipNextAsPattern) {
        skipNextAsPattern = false;
        if (token.length >= 3) return token;
      }
      previousToken = token;
      continue;
    }
    if (!foundCmd) {
      if (connectors.has(token)) {
        seenWrapper = false;
        previousToken = token;
        continue;
      }
      const commandName = basename(token);
      if (wrappers.has(commandName)) {
        seenWrapper = true;
        previousToken = token;
        continue;
      }
      if (seenWrapper && token.startsWith('-')) {
        const flagName = token.split('=', 1)[0];
        if (!token.includes('=') && wrapperFlagsWithValues.has(flagName)) skipNext = true;
        previousToken = token;
        continue;
      }
      if (seenWrapper && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        previousToken = token;
        continue;
      }
      const atCommandPosition =
        previousToken === undefined ||
        connectors.has(previousToken) ||
        wrappers.has(basename(previousToken)) ||
        seenWrapper;
      if (atCommandPosition && (commandName === 'rg' || commandName === 'grep')) {
        foundCmd = true;
        searchCommand = commandName;
      } else if (seenWrapper) {
        seenWrapper = false;
      }
      previousToken = token;
      continue;
    }
    previousToken = token;
    if (endOfOptions) {
      if (explicitPatternSeen || patternFileSeen) continue;
      return token.length >= 3 ? token : null;
    }
    if (token === '--') {
      endOfOptions = true;
      continue;
    }
    if (token.startsWith('-')) {
      if (token === '-f' || token === '--file') {
        skipNext = true;
        patternFileSeen = true;
        continue;
      }
      if (token.startsWith('--file=')) {
        patternFileSeen = true;
        continue;
      }
      if (token.startsWith('--regexp=')) {
        explicitPatternSeen = true;
        const value = token.slice('--regexp='.length);
        if (value.length >= 3) return value;
        continue;
      }
      const attachedPattern = token.match(/^-e(.+)$/);
      if (attachedPattern) {
        explicitPatternSeen = true;
        if (attachedPattern[1].length >= 3) return attachedPattern[1];
        continue;
      }
      if (
        flagsWithValues.has(token) ||
        patternFlags.has(token) ||
        (searchCommand === 'rg' && rgValueFlags.has(token))
      ) {
        skipNext = true;
        skipNextAsPattern = patternFlags.has(token);
        if (skipNextAsPattern) explicitPatternSeen = true;
      }
      continue;
    }
    if (explicitPatternSeen || patternFileSeen) continue;
    return token.length >= 3 ? token : null;
  }
  return null;
}

/**
 * Extract a search pattern from the tool input. Cursor 2.4 docs at
 * https://cursor.com/docs/agent/hooks list the tool *matchers* but do not
 * formally specify the per-tool tool_input field names, so we probe a
 * generous set of MCP-style aliases. As a last-resort fallback for Grep
 * (the highest-frequency search path) we also accept the longest plausible
 * string value in tool_input. Set GITNEXUS_DEBUG=1 to log the raw payload
 * to stderr if Cursor changes the contract and aliases stop matching.
 */
function pickLongestStringValue(obj) {
  let best = null;
  if (!obj || typeof obj !== 'object') return null;
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length >= 3 && (!best || v.length > best.length)) {
      best = v;
    }
  }
  return best;
}

function extractPattern(toolName, toolInput) {
  const t = (toolName || '').toLowerCase();

  if (t === 'grep') {
    const aliases = [
      toolInput.query,
      toolInput.pattern,
      toolInput.regex,
      toolInput.q,
      toolInput.search,
      toolInput.searchQuery,
    ];
    for (const a of aliases) {
      if (typeof a === 'string' && a.length >= 3) return a;
    }
    // Last resort: scan tool_input for any reasonable-looking string value.
    return pickLongestStringValue(toolInput);
  }

  if (t === 'read') {
    const filePath =
      toolInput.target_file ||
      toolInput.file_path ||
      toolInput.filePath ||
      toolInput.path ||
      toolInput.file ||
      '';
    if (!filePath) return null;
    const base = path.basename(String(filePath), path.extname(String(filePath)));
    const cleaned = base.replace(/[^a-zA-Z0-9_]/g, '');
    return cleaned.length >= 3 ? cleaned : null;
  }

  if (t === 'shell') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;
    return parseRgGrepPattern(cmd);
  }

  return null;
}

function resolveCliPath() {
  try {
    return require.resolve('gitnexus/dist/cli/index.js');
  } catch {
    return '';
  }
}

// The Cursor host enforces hooks.json's postToolUse `timeout` (seconds)
// against the WHOLE hook process, so the npx fallback can never get more
// than that window however long a cold `npx -y gitnexus` install (package
// download + unpack) actually takes. hooks.json ships 60s for exactly that
// download; this hook then derives the npx budget from what is LEFT of that
// window rather than from the caller's inner-CLI timeout, which was sized
// for an already-installed local CLI and would otherwise pin every cold
// install at ~7s + 5s — the very cost the 60s manifest was raised for.
//
// Three bounds, all applied by resolveNpxTimeoutMs() below:
//   HEADROOM — reserved for node startup, the hook-slot release, and the
//              final stdout write the host still has to read;
//   MIN      — below this, the remaining window is too short for a result
//              the host could ever observe (the guard's SIGKILL grace, plus
//              spawnSync teardown, plus the final write), so the npx
//              fallback is SKIPPED outright instead of starting work that
//              is guaranteed to be killed mid-flight;
//   MAX      — upper clamp so one pathologically slow install cannot hold a
//              per-repo LadybugDB hook slot for the whole host window and
//              starve concurrent edits in the same repo.
const CURSOR_NPX_HEADROOM_MS = 5000;
const CURSOR_NPX_MIN_BUDGET_MS = 5000;
const CURSOR_NPX_MAX_BUDGET_MS = 45000;
const CURSOR_HOOK_START_MS = Date.now();
const HOOK_ENV = process['env'];

function resolveCursorHostBudgetMs() {
  try {
    // hooks.json ships next to this hook script
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'hooks.json'), 'utf-8'));
    const seconds = manifest.hooks.postToolUse[0].timeout;
    if (typeof seconds === 'number' && seconds > 0) {
      return seconds * 1000;
    }
  } catch {
    /* fall through to the shipped default */
  }
  return 60000;
}

// Decide the npx fallback's budget from the host window that is actually
// left. Returns null when nothing useful fits — the caller must then skip
// the npx spawn entirely rather than floor the budget at some minimum.
//
// Two failure shapes this replaces, both silent:
//   - a `Math.max(1000, …)` floor meant an ALREADY-EXPIRED window still
//     handed the guarded arm 1000ms (plus a 2000ms spawnSync allowance), so
//     the host killed the hook before the guard could return or the final
//     stdout write could land. Starting work that cannot finish is strictly
//     worse than not starting it;
//   - an inner `timeout + 5000` ceiling capped every fallback at the old
//     7s + 5s budget, so the 60s hooks.json manifest could never actually
//     pay for a cold `npx -y gitnexus` download.
//
// Deliberately pure and parameterised so the arithmetic is testable without
// spawning npx, and so it does NOT take the caller's inner-CLI `timeout`:
// that value still sizes the direct-exec arm (where it is correct) and is
// meaningless for a cold package download.
function resolveNpxTimeoutMs(hostBudgetMs, elapsedMs) {
  const remaining = hostBudgetMs - CURSOR_NPX_HEADROOM_MS - elapsedMs;
  if (remaining < CURSOR_NPX_MIN_BUDGET_MS) return null;
  return Math.min(remaining, CURSOR_NPX_MAX_BUDGET_MS);
}

// Sentinel for the module-wide memo below:
//   undefined = not resolved yet (resolve lazily, on the first npx fallback)
//   string    = self-tested coreutils timeout/gtimeout path (use as wrapper)
//   null      = no usable wrapper (disabled, none found, or self-test failed)
let unixGuardTimeoutCache;

/**
 * A candidate is usable only when it RUNS the wrapped command AND
 * PROPAGATES its exit status, proven by
 * `timeout -k 1 1 /bin/sh -c 'exit 42'` exiting 42.
 *
 * This rejects two shapes that mere existence cannot:
 *   - wrappers WITHOUT coreutils' `-k` flag — busybox <1.34, toybox, broken
 *     symlinks — which exit with a usage error without ever running npx, so
 *     the npx grandchild is neither wrapped nor reaped;
 *   - always-exit-0 stubs (/bin/true shapes), which would be adopted and
 *     "succeed" every wrapped spawn instantly without running it. Status 0
 *     and empty stderr satisfy main()'s `!child.error && child.status === 0`
 *     check, so the hook would emit NO additional_context at all — a
 *     silently dead augmentation rather than a visible failure.
 */
function passesGuardSelfTest(guard) {
  try {
    const selfTest = spawnSync(guard, ['-k', '1', '1', '/bin/sh', '-c', 'exit 42'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    return !selfTest.error && selfTest.status === 42;
  } catch {
    return false;
  }
}

/**
 * Resolve a coreutils/BSD `timeout` binary for the npx arm. The CLI behind
 * npx is a grandchild (npx -> gitnexus), so the wrap leads with `-s KILL`:
 * a plain SIGTERM would kill only the obedient npx parent and let the
 * grandchild keep holding the LadybugDB lock after this hook released its
 * slot. Mirrors the Claude adapter's wrapped npx arm; Windows stays unwrapped
 * (npx is a .cmd script there).
 *
 * GITNEXUS_HOOK_TIMEOUT_PATH semantics (shared with the Claude adapter's
 * hook-db-lock-probe.cjs, which owns the canonical contract): the sentinel
 * `disabled` turns the wrapper off; any other value is only a CANDIDATE — an
 * existing path is tried first, but it must pass the `-k` exit-propagation
 * self-test to be adopted. On any failure (non-existent path, directory,
 * non-executable file, wrapper without `-k`, always-exit-0 stub) resolution
 * falls through to the built-ins below, tried in order, first self-test pass
 * wins. Only when EVERY candidate fails does this fall back to the unwrapped
 * status quo. This is strictly stronger than merely checking existence: no
 * bad env value of ANY shape can silently disable orphan containment.
 *
 * Memoized per hook process so the resolution — and its one self-test spawn
 * — happens at most once however many times runGitNexusCli falls through to
 * npx, and so the chosen wrapper stays stable for the process lifetime. (The
 * claude adapter memoizes module-wide so probe and adapter share one
 * self-test; this integration ships WITHOUT the probe — see main() — so the
 * memo exists purely to bound the self-test spawns.)
 *
 * Residual gap, same as the claude adapter: the self-test proves `-k` exit
 * propagation, not process-GROUP signalling. busybox >=1.34 passes it and is
 * fully usable for the direct-exec arm, but only signals its direct child,
 * so on busybox the `-s KILL` below may not reap the npx -> gitnexus
 * grandchild.
 */
function resolveUnixGuardTimeout() {
  if (unixGuardTimeoutCache !== undefined) return unixGuardTimeoutCache;
  unixGuardTimeoutCache = null;
  if (process.platform === 'win32') return unixGuardTimeoutCache;
  const fromEnv = HOOK_ENV.GITNEXUS_HOOK_TIMEOUT_PATH;
  const trimmed = fromEnv ? String(fromEnv).trim() : '';
  if (trimmed === 'disabled') return unixGuardTimeoutCache;
  const candidates = [];
  // Resolve the override against THIS process's cwd — the directory the
  // existsSync check and the self-test run in — so the cached/returned path
  // is always absolute. runGitNexusCli spawns the wrapper with a different
  // `cwd` (the tool request's), where a relative value would resolve
  // elsewhere (ENOENT) and a slashless name would switch to a PATH lookup.
  const override = trimmed ? path.resolve(trimmed) : '';
  if (override && fs.existsSync(override)) candidates.push(override);
  for (const builtin of [
    '/usr/bin/timeout',
    '/bin/timeout',
    // Homebrew's coreutils keg installs the GNU binary as `gtimeout`, NOT
    // `timeout` — /opt/homebrew/bin/timeout and /usr/local/bin/timeout do
    // not exist on any Homebrew install. Listing the un-prefixed names
    // (as an earlier revision did) meant the `-s KILL` orphan-containment
    // wrap silently never engaged on exactly the platforms where Homebrew is
    // how coreutils gets installed.
    '/opt/homebrew/bin/gtimeout',
    '/usr/local/bin/gtimeout',
  ]) {
    try {
      if (fs.existsSync(builtin)) candidates.push(builtin);
    } catch {
      /* ignore */
    }
  }
  for (const candidate of candidates) {
    if (passesGuardSelfTest(candidate)) {
      unixGuardTimeoutCache = candidate;
      break;
    }
  }
  return unixGuardTimeoutCache;
}

function runGitNexusCli(cliPath, args, cwd, timeout) {
  const isWin = process.platform === 'win32';
  if (cliPath) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf-8',
      timeout,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  const elapsed = Date.now() - CURSOR_HOOK_START_MS;
  const npxTimeout = resolveNpxTimeoutMs(resolveCursorHostBudgetMs(), elapsed);
  // Nothing usable is left of the host window, so the npx fallback is SKIPPED
  // rather than started. Starting it anyway would only hand the guard a slice
  // of an already-expired budget and let the host kill the hook mid-flight —
  // which loses the augmentation AND delays the hook-slot release that the
  // LadybugDB concurrency guard is holding on our behalf.
  //
  // Return the same shape spawnSync produces for a child that never ran:
  // no `error`, no exit `status`, empty streams. main() already gates on
  // `!child.error && child.status === 0`, so this lands on the ordinary
  // "no context to emit" path and its `finally` still releases the slot.
  if (npxTimeout === null) return { status: null, signal: null, stdout: '', stderr: '' };
  const guard = resolveUnixGuardTimeout();
  if (guard) {
    const wrapped = spawnSync(
      guard,
      [
        '-s',
        'KILL',
        '-k',
        '1',
        String(Math.ceil(npxTimeout / 1000) + 1),
        'npx',
        '-y',
        'gitnexus',
        ...args,
      ],
      {
        encoding: 'utf-8',
        // npxTimeout already excludes CURSOR_NPX_HEADROOM_MS from the host
        // window, so this +2000 allowance for spawnSync's own SIGTERM-then-
        // wait teardown still lands inside that reserved headroom.
        timeout: npxTimeout + 2000,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    if (!wrapped.error || wrapped.error.code !== 'ENOENT') {
      return wrapped;
    }
    // guard vanished between probe and spawn: fall through unwrapped
  }
  return spawnSync(isWin ? 'npx.cmd' : 'npx', ['-y', 'gitnexus', ...args], {
    encoding: 'utf-8',
    timeout: npxTimeout,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function main() {
  try {
    const input = readInput();
    if (process.env.GITNEXUS_DEBUG) {
      // Echo the payload so users can capture Cursor's actual contract when
      // diagnosing why augmentation isn't firing. Stderr only — stdout is
      // reserved for the JSON response Cursor consumes.
      try {
        process.stderr.write(
          `GitNexus Cursor hook stdin: ${JSON.stringify(input).slice(0, 500)}\n`,
        );
      } catch {
        /* never let debug logging break the hook */
      }
    }
    const cwd = input.cwd || process.cwd();
    if (!path.isAbsolute(cwd)) return;

    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};
    const pattern = extractPattern(toolName, toolInput);
    if (!pattern || pattern.length < 3) return;

    // Registry row first (persisted external storagePath wins). Local owned
    // `.gitnexus` is only the fallback when no matching registry row exists.
    const repo = resolveHookRepo(cwd);
    if (!repo) return;
    const storagePath = repo.storagePath;

    const release = acquireHookSlot(storagePath);
    if (!release) {
      // Normal skip path: all per-repo hook slots are held by concurrent
      // sessions. Stays silent by default; surfaced only under the cursor
      // hook's own GITNEXUS_DEBUG (truthy) convention. NOTE: unlike the
      // claude/plugin/antigravity adapters this integration does not install
      // hook-db-lock-probe.cjs, so its augment child is not guard-wrapped
      // yet — tracked on the #2163 follow-up list ("cursor probe").
      if (process.env.GITNEXUS_DEBUG) {
        process.stderr.write('[GitNexus] augment skipped: hook slots saturated\n');
      }
      return;
    }

    const cliPath = resolveCliPath();
    let result = '';
    try {
      const child = runGitNexusCli(cliPath, ['augment', '--', pattern], cwd, 7000);
      if (!child.error && child.status === 0) {
        result = child.stderr || '';
      }
    } catch {
      /* graceful failure */
    } finally {
      release();
    }

    if (result && result.trim()) {
      console.log(JSON.stringify({ additional_context: result.trim() }));
    }
  } catch (err) {
    if (process.env.GITNEXUS_DEBUG) {
      console.error('GitNexus Cursor hook error:', (err.message || '').slice(0, 200));
    }
  }
}

if (require.main === module) main();

// resolveUnixGuardTimeout / resolveNpxTimeoutMs are exported for the unit
// tests, which exercise the real resolver and budget arithmetic rather than
// grepping this file for substrings. They are pure helpers with no effect on
// the hook's own execution path.
module.exports = {
  parseRgGrepPattern,
  tokenizeShellWords,
  resolveUnixGuardTimeout,
  resolveNpxTimeoutMs,
};
