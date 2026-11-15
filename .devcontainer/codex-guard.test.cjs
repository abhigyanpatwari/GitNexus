'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const { refusal } = require('./codex-guard.cjs');

const GUARD = path.join(__dirname, 'codex-guard.cjs');

const DENIED = [
  'rm -rf /',
  'sudo rm -rf ~',
  'rm -fr "$HOME"',
  'cd /tmp/x && rm -rf *',
  'rm -rf /workspace',
  'rm -rf /workspace/.git',
  'rm -r ~/.claude',
  'rm /home/node/.claude-mem/claude-mem.db',
  "bash -lc 'rm -rf ..'",
  'git push --force origin feature',
  'git push -f',
  'git push origin +feature',
  'git push origin main',
  'git push origin HEAD:main',
  'git -C /workspace clean -fdx',
  'git clean -ndx',
  'dd if=/dev/zero of=/dev/sda',
  'chmod -R 777 /',
  'npm publish',
  'cd gitnexus && npm publish --access public',
  'gh repo delete abc/def --yes',
  ':(){ :|:& };:',
  'find . -name x | xargs rm -rf /',
  'FOO=1 sudo -n rm -rf ~/',
  'git -c user.name=x push --force',
  '2>/dev/null rm -rf /',
  '>/tmp/log rm -rf ~',
  '> /tmp/log rm -rf /workspace',
  '</dev/null git push --force origin feature',
  'rm 2>/dev/null -rf /',
  // What precedes a command is open-ended, so it is judged wherever it stands.
  '2>& 1 rm -rf /',
  'timeout 10 rm -rf /',
  'stdbuf -o0 rm -rf /workspace',
  '! rm -rf /',
  '(rm -rf /)',
  '{ rm -rf ~; }',
  'if true; then rm -rf /; fi',
  'echo "$(rm -rf /)"',
  'echo `git clean -fdx`',
  'eval "rm -rf /"',
  'busybox rm -rf /',
  // A leading ./ names the same thing.
  'cd /workspace && rm -rf ./*',
  'rm -rf ../*',
  'rm -rf .*',
  'rm -rf ././',
  'rm -rf ./.git',
  'rm -rf /workspace/../*',
  'rm -rf /tmp/../workspace',
  'rm -rf /workspace/.*',
  'rm -rf build/.*',
  'git push -fu origin feature',
  'git push -uf origin feature',
  'git push --mirror origin',
  // Four shells deep: refused unread.
  `sh -c "sh -c 'sh -c \\"sh -c \\\\\\"rm -rf /\\\\\\"\\"'"`,
  // An unquoted mention is refused too: the guard fails closed.
  'echo rm -rf / > notes.txt',
];

const ALLOWED = [
  'rm -rf build/',
  'rm -rf /tmp/pr-tri-review/123/run',
  'rm -rf node_modules dist',
  'rm file.txt',
  'git push origin feature',
  'git push --force-with-lease origin feature',
  'git push -u origin fix/main-thread',
  'git clean -fd',
  'git commit -m "remove rm -rf / from docs"',
  'grep -rn "git push --force" docs/',
  'npm run publish:check',
  'chmod -R u+w dist',
  'gh release view v1',
  'echo main',
  'echo "rm -rf /" > notes.txt',
  'git log --grep "push origin main"',
  'bash -lc "ls && git status"',
  'ls /nope 2>/dev/null',
  'git rm -r --cached .',
  'rm -rf ./build',
  'rm -rf /workspace/gitnexus/../dist',
  'git push -u origin feature',
  'sh -c "sh -c \'ls\'"',
  'rm -rf ./node_modules/.cache',
  // The stated limit: a computed target is not seen.
  'rm -rf "$TMP"',
  'rm -rf "$(mktemp -d)"',
  'docker rm -f web',
  'npm run reboot',
  "echo 'rm -rf /' > notes.txt",
  'rm -rf build 2>&1',
];

for (const command of DENIED) {
  test(`refuses: ${command}`, () => {
    assert.equal(typeof refusal(command), 'string');
  });
}

for (const command of ALLOWED) {
  test(`allows: ${command}`, () => {
    assert.equal(refusal(command), undefined);
  });
}

const run = (payload, env = {}) =>
  spawnSync(process.execPath, [GUARD], {
    // A string is sent as it is, so a test can hand over a payload that is not JSON.
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CODEX_GUARD: '', ...env },
  });

test('a refused Bash call exits 2 and names the reason on stderr', () => {
  const ran = run({ tool_name: 'Bash', tool_input: { command: 'git clean -fdx' } });
  assert.equal(ran.status, 2);
  assert.match(ran.stderr, /git clean -x/);
});

test('an allowed Bash call exits 0 with nothing on stderr', () => {
  const ran = run({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.equal(ran.status, 0);
  assert.equal(ran.stderr, '');
});

test('another tool is never judged', () => {
  const ran = run({ tool_name: 'apply_patch', tool_input: { command: 'rm -rf /' } });
  assert.equal(ran.status, 0);
});

test('CODEX_GUARD=off lets a refused command through', () => {
  const ran = run(
    { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
    { CODEX_GUARD: 'off' },
  );
  assert.equal(ran.status, 0);
});

test('an unreadable payload does not block', () => {
  const ran = run('not json');
  assert.equal(ran.status, 0);
});
