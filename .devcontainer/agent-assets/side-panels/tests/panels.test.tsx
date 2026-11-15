import { expect, test } from 'claude-code/testing';

const SAMPLE = `- pr-1-review
  - [doing] Resolve review feedback on PR #1 (devcontainer) (commit=abc pushed, next=read CI on abc (3 pending); fix docs, work_product=https://x/y), updated 7 minutes ago
- pr2-production: phase=Published 5743; checks queued., worktree=/home/x, updated about 17 days ago
[Work state shortened.]`;

const paneOf = (requestId: string, title: string) =>
  ({
    plugin: 'side-panels',
    component: 'Pane',
    requestId,
    props: {
      title,
      isFocused: false,
      bodyColumns: 40,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const;

const placedOf = (id: string, title: string) => ({
  id,
  title,
  isShown: true,
  isFocused: false,
  isPlaced: true,
});

const SPAWN = {
  tool_use_id: 't1',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'm',
  background: false,
  fork: false,
} as const;

const WORKER = {
  id: 'a1',
  type: 'general-purpose',
  description: 'fix parser',
  status: 'running',
} as const;

test('the work pane folds claude-mem text into lists, tasks and next steps', async ($, on) => {
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: SAMPLE }], isError: false } }));
  on('ui.panes', () => ({ value: [placedOf('work', 'Work state')] }));

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...paneOf('work', 'Work state'), surface });
    await ui.press({ key: 'refresh' });

    const task = await ui.find({ type: 'Text', text: /Resolve review/ });
    expect(task?.text).toBe('[doing] Resolve review feedback on PR #1 (devcontainer)');
    const next = await ui.find({ type: 'Text', text: /^next: / });
    expect(next?.text).toBe('next: read CI on abc (3 pending); fix docs');
    const state = await ui.find({ type: 'Text', text: /\[state\]/ });
    expect(state?.text).toBe('[state] Published 5743; checks queued.');
    await ui.unmount();
  }
});

test("a subagent's answer goes on the bus, to claude-mem and to the next worker, never to a review lane", async ($, on) => {
  const prompts: string[] = [];
  const relayed: unknown[] = [];
  on('store.get', (_, e) => ({ value: e.key === 'board' ? true : undefined }));
  on('env.get', () => ({ value: undefined }));
  on('session.id', () => ({ value: 'abcdef1234' }));
  on('ui.panes', () => ({ value: [] }));
  on('agent.list', () => ({ value: [WORKER] }));
  on('mcp.call', (_, e) => {
    relayed.push(e);

    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } };
  });
  on('turn.complete', () => ({ text: '' }));
  on('agent.spawn', (_, e) => {
    prompts.push(e.prompt);

    return { model: 'm', agentId: `b${prompts.length}` };
  });

  await $.turn.complete({
    reason: 'answer',
    answer: 'The bug is in seat(): prunable is never read.',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
  });
  await $.agent.spawn({
    ...SPAWN,
    prompt: 'Fix it.',
    description: 'fix emitter',
    subagentType: 'general-purpose',
  });
  await $.agent.spawn({
    ...SPAWN,
    prompt: 'Read it.',
    description: 'risk lane',
    subagentType: 'gitnexus-risk-architect',
  });

  // A lane a skill marked stays independent whatever it is called.
  await $.agent.spawn({
    ...SPAWN,
    prompt: '[independent-lane]\nCheck it.',
    description: 'ce persona',
    subagentType: 'general-purpose',
  });

  expect(prompts[0]).toContain(
    '- general-purpose (fix parser): The bug is in seat(): prunable is never read.',
  );
  expect(prompts[1]).toBe('Read it.');
  expect(prompts[2]).toBe('[independent-lane]\nCheck it.');
  expect(JSON.stringify(relayed)).toContain('board-abcdef12');

  const ui = await $.ui.mount({ ...paneOf('agents', 'Agents'), surface: 'terminal' });
  const row = await ui.find({ type: 'Text', text: /finished$/ });
  expect(row?.text).toBe('general-purpose (fix parser) finished');
  await ui.unmount();
});

test('the agents pane logs a message, opens an agent on a click and sends what is typed', async ($, on) => {
  const viewed: unknown[] = [];
  const sent: unknown[] = [];
  on('store.get', () => ({ value: undefined }));
  on('env.get', () => ({ value: undefined }));
  on('ui.panes', () => ({ value: [placedOf('agents', 'Agents')] }));
  on('agent.list', () => ({ value: [WORKER] }));
  on('ui.view', (_, e) => {
    viewed.push(e);

    return { value: {} };
  });
  on('session.send', (_, e) => {
    // The event names the recipient as a string, whichever form the caller passed to `$.session.send`.
    sent.push({ to: e.to, text: e.text });

    return { isDelivered: true };
  });

  await $.session.send({ to: 'a1', text: 'stop after this file', origin: { kind: 'model' } });

  const ui = await $.ui.mount({ ...paneOf('agents', 'Agents'), surface: 'terminal' });
  await ui.press({ key: 'refresh' });
  expect((await ui.find({ type: 'Text', text: /→/ }))?.text).toBe(
    'main → general-purpose (fix parser)',
  );

  await ui.press({ key: 'view-a1' });
  expect(viewed).toEqual([{ agentId: 'a1' }]);

  await ui.input({ key: 'say', text: 'also update the test' });
  expect(sent.at(-1)).toEqual({ to: 'a1', text: 'also update the test' });
  await ui.unmount();
});

test('the agents pane shows a review run: a running Codex leg, an empty one, and a finish on the bus', async ($, on) => {
  const now = Date.now();
  const RUN = '/tmp/pr-tri-review/3945/20261115-100425-e08a9358';
  const file = (name: string, size: number) =>
    ({ name, kind: 'file', size, mtimeMs: now, isLink: false }) as const;
  const STALE = '/tmp/pr-tri-review/3945/20261115-120000-aaaaaaaa';
  const dir = (name: string, mtimeMs = now) =>
    ({ name, kind: 'dir', size: 0, mtimeMs, isLink: false }) as const;
  const files = [
    file('codex-swarm.md', 20_252),
    file('codex-ce.md', 120),
    file('codex-ce.exit', 2),
    file('claude-swarm.md', 0),
    file('p-ce.txt', 449_545),
  ];
  on('store.get', () => ({ value: undefined }));
  on('env.get', () => ({ value: undefined }));
  on('ui.panes', () => ({ value: [placedOf('agents', 'Agents')] }));
  on('agent.list', () => ({ value: [] }));
  on('fs.list', (_, e) => ({
    value:
      e.path === '/tmp/pr-tri-review'
        ? [dir('3945')]
        : e.path === '/tmp/pr-tri-review/3945'
          ? // Started in the same second: the suffix is random, so the folder written last is the newer run.
            [
              dir('20261115-100425-e08a9358'),
              dir('20261115-100425-ffffffff', now - 60_000),
              // Started later, but nothing written for seven hours: the active run is shown, not this one.
              dir('20261115-120000-aaaaaaaa'),
              dir('harness'),
            ]
          : e.path === RUN
            ? files
            : e.path === STALE
              ? [{ ...file('codex-swarm.md', 900), mtimeMs: now - 7 * 60 * 60_000 }]
              : [],
  }));
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('.exit')
      ? '0\n'
      : '[codex] Thread ready (01a1).\n[codex] Running command: git diff HEAD\n',
  }));

  const ui = await $.ui.mount({ ...paneOf('agents', 'Agents'), surface: 'terminal' });
  await ui.press({ key: 'refresh' });
  expect((await ui.find({ type: 'Text', text: /^Review run/ }))?.text).toBe(
    'Review run 3945/20261115-100425-e08a9358',
  );
  expect((await ui.find({ type: 'Text', text: /^codex-swarm:/ }))?.text).toBe(
    'codex-swarm: running, 20 KB',
  );
  expect(await ui.find({ type: 'Text', text: /^Running command: git diff HEAD$/ })).toBeDefined();
  expect((await ui.find({ type: 'Text', text: /^codex-ce:/ }))?.text).toBe(
    'codex-ce: done, but nearly empty, 120 B',
  );
  expect((await ui.find({ type: 'Text', text: /^claude-swarm:/ }))?.text).toBe(
    'claude-swarm: running, no output yet, 0 B',
  );
  expect(await ui.find({ type: 'Text', text: /^p-ce/ })).toBeUndefined();

  files.push(file('codex-swarm.exit', 2));
  await ui.press({ key: 'refresh' });
  expect((await ui.find({ type: 'Text', text: /finished$/ }))?.text).toBe(
    'codex-swarm (review run) finished',
  );
  await ui.unmount();
});

test('SIDE_PANELS_BOARD=off keeps the board from every agent of that process', async ($, on) => {
  const prompts: string[] = [];
  on('store.get', (_, e) => ({ value: e.key === 'board' ? true : undefined }));
  on('env.get', (_, e) => ({ value: e.name === 'SIDE_PANELS_BOARD' ? 'off' : undefined }));
  on('ui.panes', () => ({ value: [] }));
  on('agent.list', () => ({ value: [WORKER] }));
  on('turn.complete', () => ({ text: '' }));
  on('agent.spawn', (_, e) => {
    prompts.push(e.prompt);

    return { model: 'm', agentId: `b${prompts.length}` };
  });

  await $.turn.complete({
    reason: 'answer',
    answer: 'A finding.',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
  });
  await $.agent.spawn({
    ...SPAWN,
    prompt: 'Fix it.',
    description: 'fix emitter',
    subagentType: 'general-purpose',
  });

  expect(prompts[0]).toBe('Fix it.');
});

test('the same words sent twice are two entries; one event reported twice is one', async ($, on) => {
  on('store.get', () => ({ value: undefined }));
  on('env.get', () => ({ value: undefined }));
  on('ui.panes', () => ({ value: [] }));
  on('agent.list', () => ({ value: [WORKER] }));
  on('session.send', () => ({ isDelivered: true }));
  on('turn.complete', () => ({ text: '' }));

  const message = { to: 'a1', text: 'run the tests', origin: { kind: 'model' } } as const;
  await $.session.send(message);
  await $.session.send(message);
  const finished = {
    reason: 'answer',
    answer: 'Done.',
    durationMs: 1,
    isAborted: false,
    turnId: 't9',
    agentId: 'a1',
  } as const;
  await $.turn.complete(finished);
  await $.turn.complete(finished);

  const ui = await $.ui.mount({ ...paneOf('agents', 'Agents'), surface: 'terminal' });
  expect((await ui.find({ type: 'Text', text: /^Bus \(/ }))?.text).toBe('Bus (3)');
  await ui.unmount();
});

test('a board switched off after relaying is still closed when the session ends', async ($, on) => {
  let isBoardOn = true;
  const written: string[] = [];
  on('store.get', (_, e) => ({ value: e.key === 'board' ? isBoardOn : undefined }));
  on('env.get', () => ({ value: undefined }));
  on('session.id', () => ({ value: 'abcdef1234' }));
  on('ui.panes', () => ({ value: [] }));
  on('agent.list', () => ({ value: [WORKER] }));
  on('mcp.call', (_, e) => {
    written.push(JSON.stringify(e));

    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } };
  });
  on('turn.complete', () => ({ text: '' }));
  on('session.end', () => ({ sessionId: 's1' }));

  await $.turn.complete({
    reason: 'answer',
    answer: 'A finding.',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
  });
  isBoardOn = false;
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } });

  expect(written.length).toBe(2);
  expect(written[1]).toContain('"status":"done"');
  expect(written[1]).toContain('board-abcdef12');
});

test('a session that relayed nothing closes no board', async ($, on) => {
  const written: string[] = [];
  on('store.get', (_, e) => ({ value: e.key === 'board' ? true : undefined }));
  on('env.get', () => ({ value: undefined }));
  on('mcp.call', (_, e) => {
    written.push(JSON.stringify(e));

    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } };
  });
  on('session.end', () => ({ sessionId: 's1' }));

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } });

  expect(written).toEqual([]);
});

test('a worktree that cannot be read, or has no upstream, is not called clean', async ($, on) => {
  const ran = (exitCode: number, stdout = '') => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  });
  on('store.get', () => ({ value: undefined }));
  on('env.get', () => ({ value: undefined }));
  on('ui.panes', () => ({ value: [placedOf('worktrees', 'Worktrees')] }));
  on('process.run', (_, e) => {
    const args = e.argv.slice(1).join(' ');
    if (args === 'worktree list --porcelain') {
      return ran(
        0,
        [
          'worktree /w/main\nHEAD a\nbranch refs/heads/main',
          'worktree /w/broken\nHEAD b\nbranch refs/heads/fix',
          'worktree /w/local\nHEAD c\nbranch refs/heads/spike',
        ].join('\n\n'),
      );
    }
    if (args === '--no-optional-locks status --porcelain')
      return e.init?.cwd === '/w/broken' ? ran(128) : ran(0);
    // Only main has an upstream to count against.
    return e.init?.cwd === '/w/main' ? ran(0, '0\n') : ran(128);
  });

  const ui = await $.ui.mount({ ...paneOf('worktrees', 'Worktrees'), surface: 'terminal' });
  await ui.press({ key: 'refresh' });

  expect((await ui.find({ type: 'Text', text: /unreadable/ }))?.text).toBe(
    'fix · status unreadable',
  );
  expect((await ui.find({ type: 'Text', text: /^clean:/ }))?.text).toBe('clean: main');
  expect((await ui.find({ type: 'Text', text: /^no upstream/ }))?.text).toBe(
    'no upstream, push state unknown: local',
  );
  await ui.unmount();
});

test('a message that was not delivered does not reach the bus', async ($, on) => {
  on('store.get', () => ({ value: undefined }));
  on('env.get', () => ({ value: undefined }));
  on('ui.panes', () => ({ value: [] }));
  on('agent.list', () => ({ value: [WORKER] }));
  on('session.send', () => ({ isDelivered: false, reason: 'no such agent' }));

  await $.session.send({ to: 'gone', text: 'are you there', origin: { kind: 'model' } });

  const ui = await $.ui.mount({ ...paneOf('agents', 'Agents'), surface: 'terminal' });
  expect((await ui.find({ type: 'Text', text: /^Bus \(/ }))?.text).toBe('Bus (0)');
  await ui.unmount();
});

test("/panels closes this mod's panes and leaves a pane it does not own open", async ($, on) => {
  const closed: string[] = [];
  on('ui.panes', () => ({
    value: [placedOf('work', 'Work state'), placedOf('someone-elses', 'Not ours')],
  }));
  on('ui.close', (_, e) => {
    closed.push(e.id);

    return { value: undefined };
  });

  on('store.set', () => ({ value: undefined }));

  const { text } = await $.command.run({
    command: 'panels',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  });

  expect(text).toBe('Side panels closed.');
  expect(closed).toEqual(['work']);
});
