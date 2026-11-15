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
  const dir = (name: string) =>
    ({ name, kind: 'dir', size: 0, mtimeMs: now, isLink: false }) as const;
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
          ? [dir('20261115-100425-e08a9358'), dir('harness')]
          : e.path === RUN
            ? files
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
