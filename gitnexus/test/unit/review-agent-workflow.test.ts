import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';

const WORKFLOW_PATH = path.resolve(
  __dirname,
  '../../../.github/workflows/gitnexus-review-agent.yml',
);
const RUNTIME_PACKAGE_PATH = path.resolve(
  __dirname,
  '../../../.github/gitnexus-review-runtime/package.json',
);
const RUNTIME_LOCK_PATH = path.resolve(
  __dirname,
  '../../../.github/gitnexus-review-runtime/package-lock.json',
);
const CLAUDE_RUNTIME_PACKAGE_PATH = path.resolve(
  __dirname,
  '../../../.github/claude-canary-runtime/package.json',
);
const CLAUDE_RUNTIME_LOCK_PATH = path.resolve(
  __dirname,
  '../../../.github/claude-canary-runtime/package-lock.json',
);
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const runtimePackage = JSON.parse(readFileSync(RUNTIME_PACKAGE_PATH, 'utf8')) as {
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
};
const runtimeLock = JSON.parse(readFileSync(RUNTIME_LOCK_PATH, 'utf8')) as {
  packages?: Record<string, { version?: string; integrity?: string }>;
};
const claudeRuntimePackage = JSON.parse(readFileSync(CLAUDE_RUNTIME_PACKAGE_PATH, 'utf8')) as {
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
};
const claudeRuntimeLock = JSON.parse(readFileSync(CLAUDE_RUNTIME_LOCK_PATH, 'utf8')) as {
  lockfileVersion?: number;
  packages?: Record<
    string,
    {
      dependencies?: Record<string, string>;
      engines?: Record<string, string>;
      version?: string;
      integrity?: string;
    }
  >;
};
const requireCjs = createRequire(import.meta.url);
const workflowDocument = load(workflow) as {
  jobs?: Record<
    string,
    {
      steps?: Array<{
        name?: string;
        env?: Record<string, string>;
        run?: unknown;
        with?: Record<string, unknown> & { script?: unknown };
      }>;
    }
  >;
};

const PR_NUMBER = 2431;
const CONTROL_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const BASE_SHA = '3'.repeat(40);
const CHANGED_PATH = 'gitnexus/src/cli/status.ts';

function jobBlock(name: string): string {
  const match = workflow.match(
    new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:\\n|$)`),
  );
  return match?.[0] ?? '';
}

function jobScript(job: string, stepName: string): string {
  const step = workflowDocument.jobs?.[job]?.steps?.find(({ name }) => name === stepName);
  return typeof step?.with?.script === 'string' ? step.with.script : '';
}

function jobRun(job: string, stepName: string): string {
  const step = workflowDocument.jobs?.[job]?.steps?.find(({ name }) => name === stepName);
  return typeof step?.run === 'string' ? step.run : '';
}

function embeddedNodeScript(job: string, stepName: string): string {
  const run = jobRun(job, stepName);
  const marker = "node <<'NODE'\n";
  const start = run.indexOf(marker);
  const end = run.lastIndexOf('\nNODE');
  if (start < 0 || end <= start) throw new Error(`${stepName} Node heredoc not found`);
  return run.slice(start + marker.length, end);
}

function runGit(cwd: string, arguments_: string[]): void {
  const result = spawnSync('git', arguments_, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr}`);
  }
}

type ContextScenario = {
  controlSha?: string;
  dispatchPr?: string;
  eventName?: 'issue_comment' | 'workflow_dispatch';
  eventPr?: string;
  permission?: string;
  permissionError?: Error;
  pull?: Record<string, unknown>;
  pullError?: Error;
};

async function runContextScenario({
  controlSha = CONTROL_SHA,
  dispatchPr = String(PR_NUMBER),
  eventName = 'workflow_dispatch',
  eventPr = String(PR_NUMBER),
  permission = 'write',
  permissionError,
  pull,
  pullError,
}: ContextScenario = {}) {
  const contextScript = jobScript('analyze', 'Normalize and authorize the request');
  if (!contextScript) throw new Error('context github-script block not found');

  const resolvedPull =
    pull ??
    ({
      state: 'open',
      head: { sha: HEAD_SHA, repo: { full_name: 'fork/repo' } },
      base: { sha: BASE_SHA, repo: { full_name: 'owner/repo' } },
    } as Record<string, unknown>);
  const getPermission = permissionError
    ? vi.fn().mockRejectedValue(permissionError)
    : vi.fn().mockResolvedValue({ data: { permission } });
  const getPull = pullError
    ? vi.fn().mockRejectedValue(pullError)
    : vi.fn().mockResolvedValue({ data: resolvedPull });
  const github = {
    rest: {
      repos: { getCollaboratorPermissionLevel: getPermission },
      pulls: { get: getPull },
    },
  };
  const outputs = new Map<string, string>();
  const core = {
    debug: vi.fn(),
    notice: vi.fn(),
    setOutput: vi.fn((name: string, value: string) => outputs.set(name, value)),
  };
  const context = {
    actor: 'trusted-maintainer',
    eventName,
    repo: { owner: 'owner', repo: 'repo' },
  };

  try {
    vi.stubEnv('CONTROL_SHA', controlSha);
    vi.stubEnv('DISPATCH_PR', dispatchPr);
    vi.stubEnv('EVENT_PR', eventPr);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...arguments_: string[]
    ) => (...arguments_: unknown[]) => Promise<void>;
    const execute = new AsyncFunction('github', 'context', 'core', contextScript);
    await execute(github, context, core);
  } finally {
    vi.unstubAllEnvs();
  }

  return { core, getPermission, getPull, outputs };
}

function runChangedPathManifest(rawNameStatus: string | Uint8Array) {
  const script = embeddedNodeScript('analyze', 'Prepare exact merge-base review inputs');
  const inputDirectory = mkdtempSync(path.join(tmpdir(), 'gitnexus-review-name-status-'));
  writeFileSync(path.join(inputDirectory, 'changed-name-status.bin'), rawNameStatus);
  try {
    const result = spawnSync(process.execPath, ['-'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PR_NUMBER: String(PR_NUMBER),
        HEAD_SHA,
        BASE_SHA,
        MERGE_BASE: CONTROL_SHA,
        INPUT_DIR: inputDirectory,
      },
      input: script,
    });
    const manifestPath = path.join(inputDirectory, 'changed-paths.json');
    return {
      result,
      manifest: existsSync(manifestPath)
        ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>)
        : undefined,
    };
  } finally {
    rmSync(inputDirectory, { recursive: true, force: true });
  }
}

type PublisherScenario = {
  artifactStatus: 'success' | 'failure';
  artifactOverrides?: Record<string, unknown>;
  rawArtifact?: string | Uint8Array;
  comments?: Array<{
    id: number;
    body: string;
    user: { login: string };
  }>;
  commentPages?: Array<
    Array<{
      id: number;
      body: string;
      user: { login: string };
    }>
  >;
  currentBase?: string;
  currentHead?: string;
  finalBase?: string;
  finalHead?: string;
  finalState?: string;
};

type ArtifactScenario = {
  basePaths?: string[];
  basePrescanPaths?: string[];
  changedPaths?: string[];
  entries?: Array<Record<string, string>>;
  executionFileOutput?: string;
  noIndexableChangedSymbols?: boolean;
  rawTranscript?: string | Uint8Array | ((runnerTemp: string) => string | Uint8Array);
  structuredOutput?: string;
};

function contextResultContent(filePath = CHANGED_PATH): string {
  return `${JSON.stringify({
    status: 'found',
    symbol: {
      uid: 'Function:gitnexus/src/cli/status.ts:statusCommand',
      name: 'statusCommand',
      kind: 'Function',
      filePath,
      startLine: 1,
      endLine: 20,
    },
  })}\n\n---\n**Next:** use impact() for blast radius.`;
}

function reviewTranscript({
  toolName = 'mcp__gitnexus__context',
  toolInput = { name: 'statusCommand', file_path: CHANGED_PATH },
  toolResultContent = contextResultContent(),
  resultIsError = false,
}: {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResultContent?: unknown;
  resultIsError?: boolean | undefined;
} = {}): Array<Record<string, unknown>> {
  const toolResult: Record<string, unknown> = {
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: toolResultContent,
  };
  if (resultIsError !== undefined) toolResult.is_error = resultIsError;

  return [
    {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      uuid: '11111111-1111-4111-8111-111111111111',
    },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: '22222222-2222-4222-8222-222222222222',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: toolName,
            input: toolInput,
          },
        ],
      },
    },
    {
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: '33333333-3333-4333-8333-333333333333',
      message: {
        role: 'user',
        content: [toolResult],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'session-1',
      uuid: '44444444-4444-4444-8444-444444444444',
    },
  ];
}

function reviewTranscriptWithoutTools(): Array<Record<string, unknown>> {
  return [
    {
      type: 'system',
      subtype: 'init',
      session_id: 'session-1',
      uuid: '11111111-1111-4111-8111-111111111111',
    },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: 'session-1',
      uuid: '22222222-2222-4222-8222-222222222222',
      message: { role: 'assistant', content: [] },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'session-1',
      uuid: '44444444-4444-4444-8444-444444444444',
    },
  ];
}

function runArtifactScenario({
  basePaths = [],
  basePrescanPaths = basePaths,
  changedPaths = [CHANGED_PATH],
  entries = [
    ...changedPaths.map((headPath) => ({ status: 'A', head_path: headPath })),
    ...basePaths.map((basePath) => ({ status: 'D', base_path: basePath })),
  ],
  executionFileOutput,
  noIndexableChangedSymbols = false,
  rawTranscript = JSON.stringify(reviewTranscript()),
  structuredOutput = JSON.stringify({ body: 'Accepted graph-backed review' }),
}: ArtifactScenario = {}) {
  const script = embeddedNodeScript('analyze', 'Assemble bounded review artifact');
  const runnerTemp = mkdtempSync(path.join(tmpdir(), 'gitnexus-review-artifact-'));
  const inputDirectory = path.join(runnerTemp, 'gitnexus-review-control', 'review-input');
  const transcriptPath = path.join(runnerTemp, 'claude-execution-output.json');
  const githubOutput = path.join(runnerTemp, 'github-output');
  mkdirSync(inputDirectory, { recursive: true });
  writeFileSync(
    path.join(inputDirectory, 'changed-paths.json'),
    `${JSON.stringify({
      schema: 'gitnexus.changed-paths/v2',
      entries,
      head_paths: changedPaths,
      base_paths: basePaths,
      base_prescan_paths: basePrescanPaths,
      prescan: {
        head_has_indexable_symbol: !noIndexableChangedSymbols && changedPaths.length > 0,
        base_has_indexable_symbol: !noIndexableChangedSymbols && basePrescanPaths.length > 0,
        no_indexable_changed_symbols: noIndexableChangedSymbols,
      },
    })}\n`,
  );
  writeFileSync(
    transcriptPath,
    typeof rawTranscript === 'function' ? rawTranscript(runnerTemp) : rawTranscript,
  );
  writeFileSync(githubOutput, '');

  const environment = {
    ...process.env,
    RUNNER_TEMP: runnerTemp,
    GITHUB_WORKSPACE: path.join(runnerTemp, 'workspace'),
    GITHUB_OUTPUT: githubOutput,
    PR_NUMBER: String(PR_NUMBER),
    CONTROL_SHA,
    HEAD_SHA,
    BASE_SHA,
    CONTEXT_READY: 'true',
    FAILURE_CODE: 'none',
    CONTROL_OUTCOME: 'success',
    HEAD_OUTCOME: 'success',
    VALIDATE_OUTCOME: 'success',
    SETUP_NODE_OUTCOME: 'success',
    ISOLATION_OUTCOME: 'success',
    CLAUDE_RUNTIME_OUTCOME: 'success',
    RUNTIME_OUTCOME: 'success',
    INDEX_OUTCOME: 'success',
    INPUTS_OUTCOME: 'success',
    MERGE_BASE_SOURCE_OUTCOME: 'success',
    GRAPH_PRESCAN_OUTCOME: 'success',
    CLAUDE_RECHECK_OUTCOME: 'success',
    CLAUDE_OUTCOME: 'success',
    EXECUTION_FILE: executionFileOutput ?? transcriptPath,
    STRUCTURED_OUTPUT: structuredOutput,
  };

  try {
    const result = spawnSync(process.execPath, ['-'], {
      encoding: 'utf8',
      env: environment,
      input: script,
      maxBuffer: 20_000_000,
    });
    if (result.status !== 0) {
      throw new Error(`artifact assembler failed: ${result.stderr || result.stdout}`);
    }
    const artifact = JSON.parse(
      readFileSync(path.join(runnerTemp, 'gitnexus-review-artifact', 'review.json'), 'utf8'),
    ) as {
      body: string;
      failure_code: string | null;
      graph_evidence: {
        base_has_indexable_symbol: boolean;
        head_has_indexable_symbol: boolean;
        mode: 'context' | 'no_indexable_changed_symbols';
      } | null;
      status: 'success' | 'failure';
    };
    return { artifact, stderr: result.stderr, stdout: result.stdout };
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
}

async function runPublisherScenario({
  artifactStatus,
  artifactOverrides = {},
  rawArtifact,
  comments = [],
  commentPages,
  currentBase = BASE_SHA,
  currentHead = HEAD_SHA,
  finalBase = currentBase,
  finalHead = currentHead,
  finalState = 'open',
}: PublisherScenario) {
  const publisherScript = jobScript(
    'publish',
    'Validate freshness and upsert an accepted same-SHA comment',
  );
  if (!publisherScript) throw new Error('publisher github-script block not found');

  const tempDir = mkdtempSync(path.join(tmpdir(), 'gitnexus-review-publisher-'));
  const artifactPath = path.join(tempDir, 'review.json');
  const artifact = {
    schema: 'gitnexus.review/v2',
    pr_number: PR_NUMBER,
    control_sha: CONTROL_SHA,
    head_sha: HEAD_SHA,
    base_sha: BASE_SHA,
    status: artifactStatus,
    body: artifactStatus === 'success' ? 'Accepted review body' : 'Model failed safely.',
    failure_code: artifactStatus === 'success' ? null : 'model_failed',
    graph_evidence:
      artifactStatus === 'success'
        ? {
            mode: 'context',
            head_has_indexable_symbol: true,
            base_has_indexable_symbol: false,
          }
        : null,
    ...artifactOverrides,
  };
  writeFileSync(artifactPath, rawArtifact ?? `${JSON.stringify(artifact)}\n`);

  const updateComment = vi.fn().mockResolvedValue({ data: {} });
  const createComment = vi.fn().mockResolvedValue({ data: { id: 99 } });
  const paginateIterator = vi.fn(() => {
    const pages = commentPages ?? [comments];
    return (async function* () {
      for (const page of pages) yield { data: page };
    })();
  });
  let pullRead = 0;
  const getPull = vi.fn().mockImplementation(async () => {
    const initial = pullRead++ === 0;
    return {
      data: {
        state: initial ? 'open' : finalState,
        head: {
          sha: initial ? currentHead : finalHead,
          repo: { full_name: 'fork/repo' },
        },
        base: {
          sha: initial ? currentBase : finalBase,
          repo: { full_name: 'owner/repo' },
        },
      },
    };
  });
  const github = {
    paginate: Object.assign(vi.fn(), { iterator: paginateIterator }),
    rest: {
      pulls: {
        get: getPull,
      },
      issues: {
        listComments: vi.fn(),
        updateComment,
        createComment,
      },
    },
  };
  const core = {
    info: vi.fn(),
    notice: vi.fn(),
    setFailed: vi.fn(),
    warning: vi.fn(),
  };
  const context = { repo: { owner: 'owner', repo: 'repo' } };
  const environment = {
    ARTIFACT_PATH: artifactPath,
    DOWNLOAD_OUTCOME: 'success',
    PR_NUMBER: String(PR_NUMBER),
    CONTROL_SHA,
    HEAD_SHA,
    BASE_SHA,
  };

  try {
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...arguments_: string[]
    ) => (...arguments_: unknown[]) => Promise<void>;
    const execute = new AsyncFunction('github', 'context', 'core', 'require', publisherScript);
    await execute(github, context, core, requireCjs);
  } finally {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  }

  return { core, createComment, getPull, paginate: paginateIterator, updateComment };
}

describe('gitnexus review-agent workflow security contract', () => {
  it('ships default-off activation and rollback instructions with the workflow', () => {
    expect(workflow).toContain('Activation checklist (the comment-trigger lane is OFF by default)');
    expect(workflow).toContain('Configure the repository secret CLAUDE_CODE_OAUTH_TOKEN');
    expect(workflow).toContain(
      'Run workflow_dispatch against a disposable same-repo PR and a fork PR',
    );
    expect(workflow).toContain('GITNEXUS_REVIEW_COMMENT_ENABLED=true');
    expect(workflow).toContain('Roll back immediately by setting that variable to false');
  });

  it('pins every third-party action and the GitNexus analyzer exactly', () => {
    const expectedPins = [
      'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0',
      'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3',
      'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      'anthropics/claude-code-action/base-action@3553f84341b92da26052e28acf1aa898f9511f32',
    ];

    for (const pin of expectedPins) {
      expect(workflow).toContain(pin);
    }

    const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action, `${action} must use a full immutable SHA`).toMatch(/@[0-9a-f]{40}$/);
    }

    expect(runtimePackage.dependencies?.gitnexus).toBe('1.6.9');
    expect(runtimePackage.engines?.node).toBe('22.16.0');
    expect(runtimeLock.packages?.['node_modules/gitnexus']?.version).toBe('1.6.9');
    expect(runtimeLock.packages?.['node_modules/gitnexus']?.integrity).toMatch(/^sha512-/);
    expect(workflow).not.toMatch(/gitnexus@(latest|next|beta)/);
    expect(workflow).toContain("node-version: '22.16.0'");
    expect(workflow).toContain('test "$(node --version)" = \'v22.16.0\'');
    expect(workflow).toContain('npm ci');
    expect(workflow).not.toContain('--package-lock=false');
    expect(workflow).toContain(
      'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
    );
    expect(workflow).toContain(
      'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0',
    );
  });

  it('installs inert lock payloads, then activates and preflights them offline', () => {
    const runtimeStep = workflowDocument.jobs?.analyze?.steps?.find(
      ({ name }) => name === 'Prepare exact GitNexus runtime and strict MCP config',
    );
    expect(runtimeStep?.env).toEqual({
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      ONNXRUNTIME_NODE_INSTALL: 'skip',
      SCARF_ANALYTICS: 'false',
      DO_NOT_TRACK: '1',
    });
    const script = typeof runtimeStep?.run === 'string' ? runtimeStep.run : '';
    expect(script).toContain('npm ci');
    expect(script).toContain('--ignore-scripts=true');
    expect(script).toContain('"${npm_path}" rebuild');
    expect(script).toContain('NPM_CONFIG_OFFLINE=true');
    expect(script).toContain('--offline');
    expect(script).toContain('--unshare-net');
    expect(script).toContain('NPM_CONFIG_IGNORE_SCRIPTS=false');
    expect(script).toContain('"${runtime_dir}/node_modules/.bin/gitnexus" analyze');
    expect(script).toContain('"${runtime_dir}/node_modules/.bin/gitnexus" status');
    expect(script.indexOf('npm ci')).toBeLessThan(script.indexOf('"${npm_path}" rebuild'));
    expect(script.indexOf('"${npm_path}" rebuild')).toBeLessThan(
      script.indexOf('"${runtime_dir}/node_modules/.bin/gitnexus" analyze'),
    );
  });

  it('runs the hostile-derived MCP database reader in a separate bounded sandbox', () => {
    const script = jobRun('analyze', 'Prepare exact GitNexus runtime and strict MCP config');
    const start = script.indexOf('# The index is derived from hostile parser input.');
    const end = script.indexOf('chmod 0755 "${mcp_wrapper}"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const mcpSandbox = script.slice(start, end);

    expect(script).toContain('mcp_wrapper="${RUNNER_TEMP}/gitnexus-review-mcp"');
    expect(script).toContain('MCP_WRAPPER="${mcp_wrapper}" MCP_CONFIG="${mcp_config}"');
    expect(script).toContain('command: process.env.MCP_WRAPPER');
    expect(script).toContain('args: []');
    expect(script).not.toContain('command: process.env.WRAPPER');
    expect(mcpSandbox).toContain('--unshare-user');
    expect(mcpSandbox).toContain('--unshare-pid');
    expect(mcpSandbox).toContain('--unshare-net');
    expect(mcpSandbox).toContain('--die-with-parent');
    expect(mcpSandbox).toContain('--new-session');
    expect(mcpSandbox).toContain('--ro-bind / /');
    expect(mcpSandbox).toContain('--ro-bind "${source_dir}" "${source_dir}"');
    expect(mcpSandbox).toContain('--ro-bind "${base_source_dir}" "${base_source_dir}"');
    expect(mcpSandbox).toContain('--ro-bind "${runtime_dir}" "${runtime_dir}"');
    expect(mcpSandbox).toContain('--ro-bind "${claude_runtime_dir}" "${claude_runtime_dir}"');
    expect(mcpSandbox).toContain('--bind "${storage_dir}" "${storage_dir}"');
    expect(mcpSandbox).toContain('--bind "${base_storage_dir}" "${base_storage_dir}"');
    expect(mcpSandbox).toContain('--bind "${index_home}" "${index_home}"');
    expect(mcpSandbox).toContain('--bind "${mcp_home}" "${mcp_home}"');
    expect(mcpSandbox).toContain('--bind "${mcp_tmp}" "${mcp_tmp}"');
    expect(mcpSandbox).toContain('/usr/bin/env -i');
    expect(mcpSandbox).toContain('GITNEXUS_MCP_READ_ONLY=1');
    expect(mcpSandbox).toContain('GITNEXUS_MCP_ALLOWED_REPOS=${source_dir},${base_source_dir}');
    expect(mcpSandbox).toContain('requested_command=(mcp)');
    expect(mcpSandbox).toContain(
      '"${runtime_dir}/node_modules/.bin/gitnexus" "${requested_command[@]}"',
    );
    expect(mcpSandbox).not.toContain('--bind "${source_dir}" "${source_dir}"');
    expect(mcpSandbox).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('installs the exact secret-consuming Claude executable before the action runs', () => {
    const runtimeStep = workflowDocument.jobs?.analyze?.steps?.find(
      ({ name }) => name === 'Prepare exact Claude Code executable',
    );
    const claudeStep = workflowDocument.jobs?.analyze?.steps?.find(
      ({ name }) => name === 'Run read-only graph-backed review',
    );
    const script = typeof runtimeStep?.run === 'string' ? runtimeStep.run : '';
    const expectedExecutable =
      '${{ runner.temp }}/gitnexus-review-claude-runtime/node_modules/@anthropic-ai/claude-code/bin/claude.exe';

    expect(claudeRuntimePackage.dependencies?.['@anthropic-ai/claude-code']).toBe('2.1.214');
    expect(claudeRuntimePackage.engines?.node).toBe('22.16.0');
    expect(claudeRuntimeLock.lockfileVersion).toBe(3);
    expect(claudeRuntimeLock.packages?.['node_modules/@anthropic-ai/claude-code']).toMatchObject({
      version: '2.1.214',
      integrity:
        'sha512-Gf8XbPHBacVqBlxx8sMnKWPEU6AvRNUcjD0FS6zhD44fCgCHcpbpxwSoTbHlLTqKsr/0S7wdfhjjOIq8WlYbng==',
    });
    expect(
      claudeRuntimeLock.packages?.['node_modules/@anthropic-ai/claude-code-linux-x64'],
    ).toMatchObject({
      version: '2.1.214',
      integrity:
        'sha512-NSQjXX8QjjjYdDlYbPvlse5yQ3UwsmV2vuPNR3eFaXnGVv7ymFHvDSMIkTFRLXQlmPjp+tvAN5fbH3e1C38SOw==',
    });
    expect(runtimeStep?.env).toEqual({
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      DO_NOT_TRACK: '1',
    });
    expect(script).toContain('.github/claude-canary-runtime/package-lock.json');
    expect(script).toContain('npm ci');
    expect(script).toContain('--ignore-scripts=true');
    expect(script).toContain('--unshare-net');
    expect(script).toContain('NPM_CONFIG_OFFLINE=true');
    expect(script).toContain('@anthropic-ai/claude-code/install.cjs');
    expect(script).toContain('cmp --silent');
    expect(script).toContain('3c029136f7c81f54ed4a38e9d52e655aad536433dbbde50519c8c31bb646ad14');
    expect(script).toContain("'2.1.214 (Claude Code)'");
    expect(claudeStep?.with?.path_to_claude_code_executable).toBe(expectedExecutable);
    expect(workflow).not.toContain('https://claude.ai/install.sh');
    expect(workflow.indexOf('id: claude-runtime')).toBeLessThan(
      workflow.indexOf('claude_code_oauth_token:'),
    );
    expect(workflow).toContain('CLAUDE_RUNTIME_OUTCOME: ${{ steps.claude-runtime.outcome }}');
  });

  it('gates comment triggers exactly and checks API write authority before model spend', () => {
    expect(workflow).toContain("github.event.comment.body == '@gitnexus review'");
    expect(workflow).not.toContain("contains(github.event.comment.body, '@gitnexus review')");
    expect(workflow).toContain("vars.GITNEXUS_REVIEW_COMMENT_ENABLED == 'true'");
    expect(workflow).toContain("github.event.comment.author_association == 'OWNER'");
    expect(workflow).toContain("github.event.comment.author_association == 'MEMBER'");
    expect(workflow).toContain("github.event.comment.author_association == 'COLLABORATOR'");
    expect(workflow).not.toContain("github.event.comment.author_association == 'CONTRIBUTOR'");

    const permissionCheck = workflow.indexOf('getCollaboratorPermissionLevel');
    const modelInvocation = workflow.indexOf('anthropics/claude-code-action/base-action@');
    expect(permissionCheck).toBeGreaterThan(-1);
    expect(modelInvocation).toBeGreaterThan(permissionCheck);
    expect(workflow).toContain("['admin', 'maintain', 'write'].includes(permission)");
    expect(workflow).toContain("steps.context.outputs.authorized == 'true'");
  });

  it('normalizes both events through the API and rejects unsafe PR metadata', () => {
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain('github.rest.pulls.get');
    expect(workflow).toContain("pull.state !== 'open'");
    expect(workflow).toContain('pull.base.repo.full_name');
    expect(workflow).toContain('pull.head.repo');
    expect(workflow).toContain('pull.head.sha');
    expect(workflow).toContain('pull.base.sha');
    expect(workflow).toMatch(/\^\\d\+\$|\^\[1-9\]\\d\*\$/);
    expect(workflow).toContain('/^[0-9a-f]{40}$/');
    expect(workflow).toContain('context.repo.owner');
    expect(workflow).toContain('context.repo.repo');
    expect(workflow).toContain('Number.isSafeInteger(prNumber)');
  });

  it('executes normalization for dispatch and comment events before enabling the model path', async () => {
    const dispatch = await runContextScenario({
      eventName: 'workflow_dispatch',
      dispatchPr: String(PR_NUMBER),
      eventPr: 'not-used',
      permission: 'admin',
    });
    expect(dispatch.getPermission).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      username: 'trusted-maintainer',
    });
    expect(dispatch.getPull).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: PR_NUMBER,
    });
    expect(Object.fromEntries(dispatch.outputs)).toMatchObject({
      authorized: 'true',
      ready: 'true',
      pr_number: String(PR_NUMBER),
      control_sha: CONTROL_SHA,
      head_repo: 'fork/repo',
      head_sha: HEAD_SHA,
      base_sha: BASE_SHA,
      failure_code: 'none',
    });

    const comment = await runContextScenario({
      eventName: 'issue_comment',
      dispatchPr: 'hostile-not-used',
      eventPr: String(PR_NUMBER),
      permission: 'maintain',
    });
    expect(comment.outputs.get('ready')).toBe('true');
    expect(comment.outputs.get('failure_code')).toBe('none');
  });

  it('executes the authorization boundary and fails hostile request metadata closed', async () => {
    for (const rawPr of ['0', '01', '-1', '1e3', '2431 trailing', '9007199254740992']) {
      const invalid = await runContextScenario({ dispatchPr: rawPr });
      expect(invalid.outputs.get('authorized')).toBe('false');
      expect(invalid.outputs.get('ready')).toBe('false');
      expect(invalid.outputs.get('failure_code')).toBe('invalid_pr_number');
      expect(invalid.getPermission).not.toHaveBeenCalled();
      expect(invalid.getPull).not.toHaveBeenCalled();
    }

    const invalidControl = await runContextScenario({ controlSha: `g${CONTROL_SHA.slice(1)}` });
    expect(invalidControl.outputs.get('failure_code')).toBe('invalid_control_sha');
    expect(invalidControl.getPermission).not.toHaveBeenCalled();

    const reader = await runContextScenario({ permission: 'read' });
    expect(reader.outputs.get('authorized')).toBe('false');
    expect(reader.outputs.get('ready')).toBe('false');
    expect(reader.outputs.get('failure_code')).toBe('actor_not_authorized');
    expect(reader.getPull).not.toHaveBeenCalled();
  });

  it('executes PR tuple validation and rejects hostile API responses', async () => {
    const validHead = { sha: HEAD_SHA, repo: { full_name: 'fork/repo' } };
    const validBase = { sha: BASE_SHA, repo: { full_name: 'owner/repo' } };
    const cases: Array<{ failure: string; pull: Record<string, unknown> }> = [
      {
        failure: 'invalid_pr_sha',
        pull: { state: 'open', head: { ...validHead, sha: 'not-a-sha' }, base: validBase },
      },
      {
        failure: 'pr_not_open',
        pull: { state: 'closed', head: validHead, base: validBase },
      },
      {
        failure: 'wrong_base_repository',
        pull: {
          state: 'open',
          head: validHead,
          base: { ...validBase, repo: { full_name: 'attacker/repo' } },
        },
      },
      {
        failure: 'head_repository_deleted',
        pull: { state: 'open', head: { sha: HEAD_SHA, repo: null }, base: validBase },
      },
      {
        failure: 'invalid_head_repository',
        pull: {
          state: 'open',
          head: { sha: HEAD_SHA, repo: { full_name: 'attacker/repo/extra' } },
          base: validBase,
        },
      },
    ];

    for (const scenario of cases) {
      const result = await runContextScenario({ pull: scenario.pull });
      expect(result.outputs.get('ready')).toBe('false');
      expect(result.outputs.get('failure_code')).toBe(scenario.failure);
    }

    const unavailable = await runContextScenario({
      permissionError: new Error('API unavailable'),
    });
    expect(unavailable.outputs.get('authorized')).toBe('false');
    expect(unavailable.outputs.get('ready')).toBe('false');
    expect(unavailable.outputs.get('failure_code')).toBe('metadata_unavailable');
    expect(unavailable.core.debug).toHaveBeenCalled();
  });

  it('checks out trusted control code at the workflow SHA and treats fork code as passive data', () => {
    const analyze = jobBlock('analyze');
    expect(analyze).not.toBe('');
    expect(analyze).toContain('repository: ${{ github.repository }}');
    expect(analyze).toContain('ref: ${{ steps.context.outputs.control_sha }}');
    expect(analyze).toContain('repository: ${{ steps.context.outputs.head_repo }}');
    expect(analyze).toContain('ref: ${{ steps.context.outputs.head_sha }}');
    expect(analyze).toContain('path: pr-target');
    expect(analyze.match(/fetch-depth: 0/g)?.length).toBeGreaterThanOrEqual(2);
    expect(analyze.match(/persist-credentials: false/g)?.length).toBeGreaterThanOrEqual(2);
    expect(analyze.match(/submodules: false/g)?.length).toBeGreaterThanOrEqual(2);
    expect(analyze.match(/lfs: false/g)?.length).toBeGreaterThanOrEqual(2);

    // Fetch the base commit as an object without checking it out. A non-shallow
    // fetch is intentional because the trusted diff step must compute the true
    // merge-base even when the base branch advanced after the fork point.
    expect(analyze).toContain('git fetch --no-tags origin "${BASE_SHA}"');
    expect(analyze).toContain('git cat-file -e "${BASE_SHA}^{commit}"');
    expect(analyze).toContain('git rev-parse HEAD');
    expect(analyze).toContain('git -C pr-target rev-parse HEAD');
    expect(analyze).toContain('find pr-target -path pr-target/.gitnexus -prune -o -type l -print0');
    expect(analyze).not.toContain('find pr-target -type l -print0');
    expect(analyze).toContain('realpath -m');
    expect(analyze).toContain('Escaping symlink');
    expect(analyze).toContain('gitnexus-review-hostile-dot-gitnexus');

    // The trusted job installs the lock-resolved analyzer into RUNNER_TEMP,
    // but it must never invoke package scripts from the PR checkout.
    expect(analyze).not.toMatch(/cd[^\n]*pr-target[\s\S]{0,200}npm\s+(ci|install|run)\b/);
    expect(analyze).not.toContain('npm install');
    expect(analyze).toContain('npm ci');
    expect(analyze).toContain('--prefix "${runtime_dir}"');
    expect(analyze).not.toContain('pr-target/.mcp.json');
    expect(analyze).not.toContain('pr-target/.claude');
    expect(analyze).not.toContain('node pr-target/.gitnexus/run.cjs');
    expect(analyze).toContain("GITNEXUS_NO_GITIGNORE: '1'");
    expect(analyze).toContain('for config in .gitnexusrc .gitnexusignore');
    expect(analyze).toContain('trap restore_target_config EXIT');
  });

  it('contains the real hostile index build and exposes only dedicated writable stores', () => {
    const script = jobRun('analyze', 'Build the exact-head graph index');
    const readOnlySource =
      '--ro-bind "${GITHUB_WORKSPACE}/pr-target" "${GITHUB_WORKSPACE}/pr-target"';
    const writableStorage = '--bind "${storage_dir}" "${storage_dir}"';
    const analyzeInvocation = '"${wrapper}" analyze --force --pdg --index-only --no-stats';

    expect(script).toContain('storage_dir="${GITHUB_WORKSPACE}/pr-target/.gitnexus"');
    expect(script).toContain('storage_quarantine=');
    expect(script).toContain('mv -- "${storage_dir}" "${storage_quarantine}"');
    expect(script).toContain('test ! -e "${storage_dir}" && test ! -L "${storage_dir}"');
    expect(script).toContain('install -d -m 0700 "${storage_dir}"');
    expect(script).toContain("stat -c '%u'");
    expect(script).toContain("stat -c '%a'");
    expect(script).toContain('--unshare-user');
    expect(script).toContain('--unshare-pid');
    expect(script).toContain('--unshare-net');
    expect(script).toContain('--die-with-parent');
    expect(script).toContain('--new-session');
    expect(script).toContain('--ro-bind / /');
    expect(script).toContain(readOnlySource);
    expect(script).toContain(writableStorage);
    expect(script).toContain('--bind "${index_home}" "${index_home}"');
    expect(script).toContain('--bind "${sandbox_home}" "${sandbox_home}"');
    expect(script).toContain('--bind "${sandbox_tmp}" "${sandbox_tmp}"');
    expect(script).toContain('/usr/bin/env -i');
    expect(script).toContain(analyzeInvocation);
    expect(script.indexOf(readOnlySource)).toBeLessThan(script.indexOf(writableStorage));
    expect(script.indexOf(writableStorage)).toBeLessThan(script.indexOf(analyzeInvocation));
    expect(script).not.toContain(
      '--bind "${GITHUB_WORKSPACE}/pr-target" "${GITHUB_WORKSPACE}/pr-target"',
    );
    expect(script).not.toContain('"${RUNNER_TEMP}/gitnexus-review" analyze');
  });

  it('builds exact head and merge-base graphs from trusted name-status topology', () => {
    const runtime = jobRun('analyze', 'Prepare exact GitNexus runtime and strict MCP config');
    const mergeBase = jobRun('analyze', 'Materialize the exact merge-base graph source');
    const index = jobRun('analyze', 'Build the exact-head graph index');
    const inputs = jobRun('analyze', 'Prepare exact merge-base review inputs');
    const prescan = jobRun('analyze', 'Prescan exact changed-symbol graph evidence');

    expect(mergeBase).toContain('git -C pr-target merge-base');
    expect(mergeBase).toContain('checkout --quiet --detach "${merge_base}"');
    expect(mergeBase).toContain('write-tree');
    expect(mergeBase).toContain('Escaping merge-base symlink');
    expect(index).toContain('gitnexus-review-merge-base');
    expect(index).toContain('gitnexus-review-hostile-base-dot-gitnexus');
    expect(index.match(/analyze --force --pdg --index-only --no-stats/g)).toHaveLength(2);
    expect(runtime).toContain('GITNEXUS_MCP_ALLOWED_REPOS=${source_dir},${base_source_dir}');
    expect(runtime).toContain('--ro-bind "${base_source_dir}" "${base_source_dir}"');
    expect(inputs).toContain('--name-status');
    expect(inputs).toContain("schema: 'gitnexus.changed-paths/v2'");
    expect(inputs).toContain("status.startsWith('R')");
    expect(inputs).toContain('basePaths.add(oldPath)');
    expect(inputs).toContain('basePrescanPaths.add(oldPath)');
    expect(inputs).toContain('headPaths.add(newPath)');
    expect(prescan).toContain('manifest.base_prescan_paths');
    expect(prescan).toContain("['cypher', statement, '--repo', repo, '--limit', '1']");
    expect(prescan).toContain("AND NOT n.id STARTS WITH 'BasicBlock:'");
    expect(prescan).toContain('no_indexable_changed_symbols');
  });

  it('parses deletion and rename-old paths into the merge-base evidence set', () => {
    const deletedPath = 'src/deleted.ts';
    const oldPath = 'src/old-name.ts';
    const newPath = 'src/new-name.ts';
    const copySource = 'src/copy-source.ts';
    const copyTarget = 'src/copy-target.ts';
    const addedPath = 'src/added.ts';
    const modifiedPath = 'src/modified.ts';
    const { manifest, result } = runChangedPathManifest(
      `D\0${deletedPath}\0R077\0${oldPath}\0${newPath}\0C050\0${copySource}\0${copyTarget}\0A\0${addedPath}\0M\0${modifiedPath}\0`,
    );

    expect(result.status).toBe(0);
    expect(manifest).toEqual({
      schema: 'gitnexus.changed-paths/v2',
      entries: [
        { status: 'D', base_path: deletedPath },
        { status: 'R077', base_path: oldPath, head_path: newPath },
        { status: 'C050', head_path: copyTarget, copy_source: copySource },
        { status: 'A', head_path: addedPath },
        {
          status: 'M',
          base_prescan_path: modifiedPath,
          head_path: modifiedPath,
        },
      ],
      head_paths: [newPath, copyTarget, addedPath, modifiedPath],
      base_paths: [deletedPath, oldPath],
      base_prescan_paths: [deletedPath, oldPath, modifiedPath],
      prescan: null,
    });

    const hostile = runChangedPathManifest('D\0../escape.ts\0');
    expect(hostile.result.status).not.toBe(0);
    expect(hostile.manifest).toBeUndefined();
    expect(hostile.result.stderr).toContain('invalid path');
  });

  it('accepts zero-padded rename and copy scores at the artifact boundary', () => {
    const renamedFrom = 'src/renamed-from.ts';
    const renamedTo = 'src/renamed-to.ts';
    const copiedFrom = 'src/copied-from.ts';
    const copiedTo = 'src/copied-to.ts';
    const { artifact } = runArtifactScenario({
      basePaths: [renamedFrom],
      changedPaths: [renamedTo, copiedTo],
      entries: [
        { status: 'R077', base_path: renamedFrom, head_path: renamedTo },
        { status: 'C050', copy_source: copiedFrom, head_path: copiedTo },
      ],
      rawTranscript: JSON.stringify(
        reviewTranscript({
          toolInput: { name: 'renamedCommand', file_path: renamedTo },
          toolResultContent: contextResultContent(renamedTo),
        }),
      ),
    });

    expect(artifact.status).toBe('success');
  });

  it('copies the indexed HEAD tree below the passive review root without prefix collisions', () => {
    const analyze = jobBlock('analyze');
    const prefixTemplate = analyze.match(/checkout-index --all --force --prefix="([^"]+)"/)?.[1];
    expect(prefixTemplate).toBe('${review_dir}/');

    const tempDir = mkdtempSync(path.join(tmpdir(), 'gitnexus-review-checkout-index-'));
    const repository = path.join(tempDir, 'source');
    const reviewDirectory = path.join(tempDir, 'control', 'pr-target');
    try {
      mkdirSync(path.join(repository, 'nested'), { recursive: true });
      mkdirSync(reviewDirectory, { recursive: true });
      writeFileSync(path.join(repository, 'root.txt'), 'root\n');
      writeFileSync(path.join(repository, 'nested', 'child.txt'), 'child\n');
      runGit(repository, ['init', '--quiet']);
      runGit(repository, ['add', 'root.txt', 'nested/child.txt']);

      const expandedPrefix = prefixTemplate?.replace('${review_dir}', reviewDirectory);
      expect(expandedPrefix).toBe(`${reviewDirectory}/`);
      runGit(repository, ['checkout-index', '--all', '--force', `--prefix=${expandedPrefix}`]);

      expect(existsSync(path.join(reviewDirectory, 'root.txt'))).toBe(true);
      expect(existsSync(path.join(reviewDirectory, 'nested', 'child.txt'))).toBe(true);
      expect(existsSync(`${reviewDirectory}root.txt`)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the model job read-only and the publisher secretless and checkout-free', () => {
    const analyze = jobBlock('analyze');
    const publish = jobBlock('publish');
    expect(workflow).toMatch(/^permissions:\s*\{\}\s*$/m);
    expect(analyze).toContain('contents: read');
    expect(analyze).toContain('pull-requests: read');
    expect(analyze).not.toContain('issues: write');
    expect(publish).toContain('issues: write');
    expect(publish).toContain('pull-requests: write');
    expect(publish).not.toContain('contents: write');
    expect(publish).not.toContain('actions/checkout@');
    expect(publish).not.toContain('ANTHROPIC_API_KEY');
    expect(publish).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(publish).not.toContain('secrets.');
    expect(publish).not.toContain('anthropics/claude-code-action/');
  });

  it('preflights the exact Bubblewrap primitive before exposing the model secret', () => {
    const analyze = jobBlock('analyze');
    const install = analyze.indexOf(
      'sudo apt-get install --yes --no-install-recommends bubblewrap',
    );
    const canary = analyze.indexOf('--unshare-user');
    const model = analyze.indexOf('claude_code_oauth_token:');

    expect(install).toBeGreaterThan(-1);
    expect(canary).toBeGreaterThan(install);
    expect(model).toBeGreaterThan(canary);
    expect(analyze).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
    expect(analyze).toContain('--unshare-pid');
    expect(analyze).toContain('--die-with-parent');
    expect(analyze).toContain('--new-session');
    expect(analyze).toContain('--ro-bind / /');
    expect(analyze).toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB');
  });

  it('rechecks the pinned Claude executable immediately before exposing the secret', () => {
    const recheck = jobRun('analyze', 'Reverify exact Claude executable at secret boundary');
    const inputs = workflow.indexOf('- name: Prepare exact merge-base review inputs');
    const recheckStep = workflow.indexOf(
      '- name: Reverify exact Claude executable at secret boundary',
    );
    const modelStep = workflow.indexOf('- name: Run read-only graph-backed review');
    const token = workflow.indexOf('claude_code_oauth_token:');

    expect(recheck).toContain('cmp --silent -- "${native_binary}" "${claude_binary}"');
    expect(recheck).toContain('3c029136f7c81f54ed4a38e9d52e655aad536433dbbde50519c8c31bb646ad14');
    expect(recheck).toContain("'2.1.214 (Claude Code)'");
    expect(inputs).toBeGreaterThan(-1);
    expect(recheckStep).toBeGreaterThan(inputs);
    expect(modelStep).toBeGreaterThan(recheckStep);
    expect(token).toBeGreaterThan(modelStep);
    expect(workflow).toContain("steps.claude-recheck.outcome == 'success'");
    expect(workflow).toContain('CLAUDE_RECHECK_OUTCOME: ${{ steps.claude-recheck.outcome }}');
    expect(workflow).toContain("process.env.CLAUDE_RECHECK_OUTCOME !== 'success'");
  });

  it('uses only trusted agent configuration and a strict, exact analyzer MCP', () => {
    const analyze = jobBlock('analyze');
    expect(analyze).toContain('anthropics/claude-code-action/base-action@');
    expect(analyze).not.toContain('uses: anthropics/claude-code-action@');
    expect(analyze).not.toContain('github_token:');
    expect(analyze).toContain('--add-dir "${{ runner.temp }}/gitnexus-review-pr-target"');
    expect(analyze).toContain('Read(${{ runner.temp }}/gitnexus-review-pr-target/**)');
    expect(analyze).toContain('review_dir="${RUNNER_TEMP}/gitnexus-review-pr-target"');
    expect(analyze).not.toContain('review_dir="${control_dir}/pr-target"');
    expect(analyze).toContain(
      'CLAUDE_CONFIG_DIR: ${{ runner.temp }}/gitnexus-review-claude-config',
    );
    expect(analyze).toContain('CLAUDE_WORKING_DIR: ${{ runner.temp }}/gitnexus-review-control');
    expect(analyze).toContain("NODE_VERSION: '22.16.0'");
    expect(analyze).toContain('checkout-index --all --force');
    expect(analyze).toContain('find "${review_dir}" -type l -print0');
    expect(analyze).toContain('Escaping copied review symlink');
    expect(analyze).toContain(
      'cp -a -- .claude/skills/gitnexus-review/. "${control_dir}/trusted-skill/"',
    );
    expect(analyze).toContain('trusted-skill/SKILL.md');
    expect(analyze).toContain('"disableAllHooks":true');
    expect(analyze).toContain('"disableSkillShellExecution":true');
    expect(analyze).toContain('--setting-sources user');
    expect(analyze).not.toContain('--setting-sources ""');
    expect(analyze).toContain('--strict-mcp-config');
    expect(analyze).toContain('--mcp-config');
    expect(analyze).toContain('--disable-slash-commands');
    expect(analyze).toContain('.github/gitnexus-review-runtime/package-lock.json');
    expect(analyze).toContain('GITNEXUS_MCP_READ_ONLY=1');
    expect(analyze).toContain('GITNEXUS_MCP_ALLOWED_REPOS');
    expect(analyze).toContain('GITNEXUS_MCP_DEFAULT_REPO');
    expect(analyze).toContain('NPM_CONFIG_IGNORE_SCRIPTS');
    expect(analyze).toContain("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'");
    expect(analyze).toContain("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0'");
    expect(analyze).toContain('--disallowedTools');
    expect(analyze).toContain('Bash');
    expect(analyze).toContain('Write');
    expect(analyze).toContain('Edit');
    const allowedTools = analyze.match(/--allowedTools "([^"]+)"/)?.[1] ?? '';
    const allowedToolRules = allowedTools.split(',');
    expect(allowedToolRules).toContain('Read(./**)');
    expect(allowedToolRules).not.toContain('Read');
    expect(allowedToolRules).not.toContain('Glob');
    expect(allowedToolRules).not.toContain('Grep');
    expect(allowedTools).toContain('mcp__gitnexus__impact');
    expect(allowedTools).not.toContain('mcp__gitnexus__detect_changes');
    expect(allowedTools).not.toContain('mcp__gitnexus__rename');
    expect(allowedTools).not.toContain('mcp__gitnexus__cypher');
    expect(analyze).toContain('Read(/proc/**)');
    expect(analyze).toContain('Read(${{ github.workspace }}/**)');
    expect(analyze).toContain(
      'mcp__gitnexus__detect_changes,mcp__gitnexus__rename,mcp__gitnexus__cypher',
    );
    expect(analyze).toContain('# shellcheck disable=SC2016');
    expect(analyze).toContain('HEAD_SHA: ${{ steps.context.outputs.head_sha }}');
    expect(analyze).toContain('test "$(git -C pr-target rev-parse HEAD)" = "${HEAD_SHA}"');
    expect(analyze).not.toContain(
      'test "$(git -C pr-target rev-parse HEAD)" = "${{ steps.context.outputs.head_sha }}"',
    );
  });

  it('bounds and validates the structured artifact across the trust boundary', () => {
    const analyze = jobBlock('analyze');
    const publish = jobBlock('publish');
    expect(analyze).toContain('if: always()');
    expect(analyze).toContain('gitnexus.review/v2');
    expect(analyze).toContain('--json-schema');
    expect(analyze).toContain('steps.claude.outputs.structured_output');
    expect(analyze).toContain('steps.claude.outputs.execution_file');
    expect(analyze).toContain('fs.constants.O_NOFOLLOW');
    expect(analyze).toContain('fs.fstatSync(descriptor)');
    expect(analyze).toContain('fs.readSync(descriptor');
    expect(analyze).toContain('fs.closeSync(descriptor)');
    expect(analyze).toContain('Buffer.byteLength');
    expect(analyze).toContain('60_000');
    expect(analyze).toContain('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(publish).toContain('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c');
    expect(analyze).toContain('name=gitnexus-review-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}');
    expect(analyze).toContain('artifact_name: ${{ steps.artifact.outputs.name }}');
    expect(analyze).toContain('name: ${{ steps.artifact.outputs.name }}');
    expect(analyze).toContain('fs.appendFileSync(process.env.GITHUB_OUTPUT');
    expect(analyze).toContain('`status=${artifact.status}\\n`');
    expect(analyze).toContain('id: upload');
    expect(analyze).toContain('Fail incomplete analysis after preserving the publisher handoff');
    expect(analyze).toContain("steps.artifact.outputs.status != 'success'");
    expect(analyze.indexOf('id: upload')).toBeLessThan(
      analyze.indexOf('Fail incomplete analysis after preserving the publisher handoff'),
    );
    expect(publish).toContain('name: ${{ needs.analyze.outputs.artifact_name }}');
    expect(publish).toContain('gitnexus.review/v2');
    expect(publish).toContain('Buffer.byteLength');
    expect(publish).toContain('60_000');
    expect(publish).toContain('RESERVED_MARKER_RE');
    expect(publish).toContain('\\u200b');
  });

  it('accepts a structured review only after a substantive exact-path context result', () => {
    const { artifact } = runArtifactScenario();

    expect(artifact).toEqual({
      schema: 'gitnexus.review/v2',
      pr_number: PR_NUMBER,
      control_sha: CONTROL_SHA,
      head_sha: HEAD_SHA,
      base_sha: BASE_SHA,
      status: 'success',
      body: 'Accepted graph-backed review',
      failure_code: null,
      graph_evidence: {
        mode: 'context',
        head_has_indexable_symbol: true,
        base_has_indexable_symbol: false,
      },
    });
  });

  it('accepts deletion and rename-old evidence only from the exact merge-base graph', () => {
    const deletedPath = 'gitnexus/src/cli/deleted-command.ts';
    const fromMergeBase = runArtifactScenario({
      basePaths: [deletedPath],
      changedPaths: [],
      rawTranscript: (runnerTemp) =>
        JSON.stringify(
          reviewTranscript({
            toolInput: {
              name: 'deletedCommand',
              file_path: deletedPath,
              repo: path.join(runnerTemp, 'gitnexus-review-merge-base'),
            },
            toolResultContent: contextResultContent(deletedPath),
          }),
        ),
    });
    expect(fromMergeBase.artifact).toMatchObject({
      status: 'success',
      failure_code: null,
      graph_evidence: {
        mode: 'context',
        head_has_indexable_symbol: false,
        base_has_indexable_symbol: true,
      },
    });

    const renameOldPath = 'gitnexus/src/cli/renamed-command.ts';
    const renameNewPath = 'gitnexus/src/cli/current-command.ts';
    const fromRenameOld = runArtifactScenario({
      basePaths: [renameOldPath],
      changedPaths: [renameNewPath],
      entries: [
        {
          status: 'R077',
          base_path: renameOldPath,
          head_path: renameNewPath,
        },
      ],
      rawTranscript: (runnerTemp) =>
        JSON.stringify(
          reviewTranscript({
            toolInput: {
              name: 'renamedCommand',
              file_path: renameOldPath,
              repo: path.join(runnerTemp, 'gitnexus-review-merge-base'),
            },
            toolResultContent: contextResultContent(renameOldPath),
          }),
        ),
    });
    expect(fromRenameOld.artifact).toMatchObject({
      status: 'success',
      failure_code: null,
      graph_evidence: { mode: 'context' },
    });

    const fromDefaultHead = runArtifactScenario({
      basePaths: [deletedPath],
      changedPaths: [],
      rawTranscript: JSON.stringify(
        reviewTranscript({
          toolInput: { name: 'deletedCommand', file_path: deletedPath },
          toolResultContent: contextResultContent(deletedPath),
        }),
      ),
    });
    expect(fromDefaultHead.artifact.failure_code).toBe('missing_graph_evidence');
  });

  it('rejects merge-base context for modified paths that are prescan-only there', () => {
    const modifiedPath = 'gitnexus/src/cli/modified-command.ts';
    const fromMergeBase = runArtifactScenario({
      basePrescanPaths: [modifiedPath],
      changedPaths: [modifiedPath],
      entries: [
        {
          status: 'M',
          base_prescan_path: modifiedPath,
          head_path: modifiedPath,
        },
      ],
      rawTranscript: (runnerTemp) =>
        JSON.stringify(
          reviewTranscript({
            toolInput: {
              name: 'modifiedCommand',
              file_path: modifiedPath,
              repo: path.join(runnerTemp, 'gitnexus-review-merge-base'),
            },
            toolResultContent: contextResultContent(modifiedPath),
          }),
        ),
    });

    expect(fromMergeBase.artifact).toMatchObject({
      status: 'failure',
      failure_code: 'missing_graph_evidence',
    });

    const inconsistent = runArtifactScenario({
      basePaths: [modifiedPath],
      basePrescanPaths: [modifiedPath],
      changedPaths: [modifiedPath],
      entries: [
        {
          status: 'M',
          base_prescan_path: modifiedPath,
          head_path: modifiedPath,
        },
      ],
    });
    expect(inconsistent.artifact.failure_code).toBe('invalid_execution_transcript');
    expect(inconsistent.stderr).toContain('changed-path manifest topology is inconsistent');
  });

  it('permits the explicit no-indexable mode only when the trusted prescan proves it', () => {
    const accepted = runArtifactScenario({
      changedPaths: ['docs/review-agent.md'],
      noIndexableChangedSymbols: true,
      rawTranscript: JSON.stringify(reviewTranscriptWithoutTools()),
    });
    expect(accepted.artifact).toMatchObject({
      status: 'success',
      failure_code: null,
      graph_evidence: {
        mode: 'no_indexable_changed_symbols',
        head_has_indexable_symbol: false,
        base_has_indexable_symbol: false,
      },
    });

    const rejected = runArtifactScenario({
      changedPaths: [CHANGED_PATH],
      noIndexableChangedSymbols: false,
      rawTranscript: JSON.stringify(reviewTranscriptWithoutTools()),
    });
    expect(rejected.artifact).toMatchObject({
      status: 'failure',
      failure_code: 'missing_graph_evidence',
      graph_evidence: null,
    });
  });

  it('rejects non-context tools and context calls not tied to an exact changed path', () => {
    const listOnly = runArtifactScenario({
      rawTranscript: JSON.stringify(
        reviewTranscript({
          toolName: 'mcp__gitnexus__list_repos',
          toolInput: {},
        }),
      ),
    });
    expect(listOnly.artifact).toMatchObject({
      status: 'failure',
      failure_code: 'missing_graph_evidence',
    });
    expect(listOnly.artifact.body).toContain('successful GitNexus context result');
    expect(listOnly.stderr).toContain('no substantive exact-path GitNexus context result');

    const unrelated = runArtifactScenario({
      rawTranscript: JSON.stringify(
        reviewTranscript({
          toolInput: {
            name: 'statusCommand',
            file_path: 'gitnexus/src/cli/status.ts.backup',
          },
        }),
      ),
    });
    expect(unrelated.artifact.failure_code).toBe('missing_graph_evidence');

    const failedQuery = runArtifactScenario({
      rawTranscript: JSON.stringify(reviewTranscript({ resultIsError: true })),
    });
    expect(failedQuery.artifact.failure_code).toBe('missing_graph_evidence');
  });

  it('accepts SDK text-block results with omitted is_error', () => {
    const result = runArtifactScenario({
      rawTranscript: JSON.stringify(
        reviewTranscript({
          resultIsError: undefined,
          toolResultContent: [{ type: 'text', text: contextResultContent() }],
        }),
      ),
    });

    expect(result.artifact).toMatchObject({ status: 'success', failure_code: null });
  });

  it('rejects semantic errors, no-results, and context results for another file', () => {
    const semanticError = runArtifactScenario({
      rawTranscript: JSON.stringify(
        reviewTranscript({
          toolResultContent: `${JSON.stringify({ error: "Symbol 'statusCommand' not found" })}\n\n---\n**Next:** retry.`,
        }),
      ),
    });
    expect(semanticError.artifact.failure_code).toBe('missing_graph_evidence');

    const noResults = runArtifactScenario({
      rawTranscript: JSON.stringify(reviewTranscript({ toolResultContent: 'No results found.' })),
    });
    expect(noResults.artifact.failure_code).toBe('missing_graph_evidence');

    const wrongPath = runArtifactScenario({
      rawTranscript: JSON.stringify(
        reviewTranscript({ toolResultContent: contextResultContent('gitnexus/src/cli/index.ts') }),
      ),
    });
    expect(wrongPath.artifact.failure_code).toBe('missing_graph_evidence');
  });

  it('fails closed on malformed or empty context result content', () => {
    const malformed = runArtifactScenario({
      rawTranscript: JSON.stringify(reviewTranscript({ toolResultContent: '{not-json' })),
    });
    expect(malformed.artifact.failure_code).toBe('invalid_execution_transcript');
    expect(malformed.stderr).toContain('context tool result is not strict JSON');

    const empty = runArtifactScenario({
      rawTranscript: JSON.stringify(reviewTranscript({ toolResultContent: '   ' })),
    });
    expect(empty.artifact.failure_code).toBe('invalid_execution_transcript');
    expect(empty.stderr).toContain('tool result content is empty');
  });

  it('fails closed on malformed execution transcript data', () => {
    const malformed = runArtifactScenario({ rawTranscript: '{not-json' });

    expect(malformed.artifact).toMatchObject({
      status: 'failure',
      failure_code: 'invalid_execution_transcript',
    });
    expect(malformed.artifact.body).toContain('failed strict validation');
    expect(malformed.stderr).toContain('execution transcript validation failed');
  });

  it('fails closed before parsing an oversized execution transcript', () => {
    const oversized = runArtifactScenario({
      rawTranscript: new Uint8Array(8_000_001).fill(0x20),
    });

    expect(oversized.artifact).toMatchObject({
      status: 'failure',
      failure_code: 'invalid_execution_transcript',
    });
    expect(oversized.stderr).toContain('execution transcript type or size is invalid');
  });

  it('publishes idempotently and discards every stale tuple', () => {
    const publish = jobBlock('publish');
    expect(publish).toContain('github.rest.pulls.get');
    expect(publish).toContain('github-actions[bot]');
    expect(publish).toContain('gitnexus-review-agent:');
    expect(publish).toContain('sameShaComment');
    expect(publish).toContain('analyzedTupleValid');
    expect(publish).toContain('publicationHead');
    expect(publish).toContain('no model output was accepted');
    expect(publish).toContain('currentBase !== baseSha');
    expect(publish).toContain('if (isStale)');
    expect(publish).toContain('stale output was discarded');
    expect(publish).toContain('github.paginate.iterator');
    expect(publish).toContain('MAX_COMMENT_PAGES = 20');
    expect(publish).toContain('MAX_COMMENTS = 2_000');
    expect(publish).toContain('sameShaComment && !publicationSucceeded');
    expect(publish).not.toContain('currentHeadComment');
    expect(publish).toContain('github.rest.issues.updateComment');
    expect(publish).toContain('github.rest.issues.createComment');
  });

  it('preserves an existing same-tuple comment when a rerun fails', async () => {
    const existing = {
      id: 17,
      user: { login: 'github-actions[bot]' },
      body: `<!-- gitnexus-review-agent:${PR_NUMBER}:${HEAD_SHA}:${BASE_SHA} -->\nAccepted earlier review`,
    };

    const { createComment, updateComment } = await runPublisherScenario({
      artifactStatus: 'failure',
      comments: [existing],
    });

    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('replaces a same-tuple failure with a later accepted review', async () => {
    const existing = {
      id: 18,
      user: { login: 'github-actions[bot]' },
      body: `<!-- gitnexus-review-agent:${PR_NUMBER}:${HEAD_SHA}:${BASE_SHA} -->\nEarlier failure`,
    };

    const { createComment, updateComment } = await runPublisherScenario({
      artifactStatus: 'success',
      comments: [existing],
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledOnce();
    expect(updateComment.mock.calls[0]?.[0]).toMatchObject({
      comment_id: existing.id,
    });
    expect(updateComment.mock.calls[0]?.[0].body).toContain('Accepted review body');
  });

  it('re-fetches the PR tuple immediately before update or create and rejects a late move', async () => {
    const movedHead = '7'.repeat(40);
    const result = await runPublisherScenario({
      artifactStatus: 'success',
      finalHead: movedHead,
    });

    expect(result.getPull).toHaveBeenCalledTimes(2);
    expect(result.paginate).toHaveBeenCalledOnce();
    expect(result.updateComment).not.toHaveBeenCalled();
    expect(result.createComment).not.toHaveBeenCalled();
    expect(result.core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('changed immediately before publication'),
    );
  });

  it('publishes an initial failure fallback but fails every stale tuple', async () => {
    const failed = await runPublisherScenario({ artifactStatus: 'failure' });
    expect(failed.updateComment).not.toHaveBeenCalled();
    expect(failed.createComment).toHaveBeenCalledOnce();
    expect(failed.createComment.mock.calls[0]?.[0].body).toContain(
      'GitNexus review — unable to complete',
    );

    const stale = await runPublisherScenario({
      artifactStatus: 'success',
      currentHead: '4'.repeat(40),
    });
    expect(stale.updateComment).not.toHaveBeenCalled();
    expect(stale.createComment).not.toHaveBeenCalled();
    expect(stale.paginate).not.toHaveBeenCalled();
    expect(stale.core.setFailed).toHaveBeenCalledWith(expect.stringContaining('stale output'));

    const staleBase = await runPublisherScenario({
      artifactStatus: 'success',
      currentBase: '5'.repeat(40),
    });
    expect(staleBase.createComment).not.toHaveBeenCalled();
    expect(staleBase.paginate).not.toHaveBeenCalled();
    expect(staleBase.core.setFailed).toHaveBeenCalledWith(expect.stringContaining('stale output'));
  });

  it('rejects malformed and mismatched artifacts at the publisher boundary', async () => {
    const scenarios: PublisherScenario[] = [
      { artifactStatus: 'success', rawArtifact: '{not-json' },
      { artifactStatus: 'success', rawArtifact: Uint8Array.from([0xff, 0xfe]) },
      { artifactStatus: 'success', artifactOverrides: { unexpected: true } },
      { artifactStatus: 'success', artifactOverrides: { base_sha: '6'.repeat(40) } },
      { artifactStatus: 'success', artifactOverrides: { body: 'x'.repeat(54_001) } },
      { artifactStatus: 'success', artifactOverrides: { failure_code: 'model_failed' } },
      {
        artifactStatus: 'success',
        artifactOverrides: {
          graph_evidence: {
            mode: 'no_indexable_changed_symbols',
            head_has_indexable_symbol: true,
            base_has_indexable_symbol: false,
          },
        },
      },
    ];

    for (const scenario of scenarios) {
      const result = await runPublisherScenario(scenario);
      expect(result.updateComment).not.toHaveBeenCalled();
      expect(result.createComment).toHaveBeenCalledOnce();
      expect(result.createComment.mock.calls[0]?.[0].body).toContain('failed safely');
      expect(result.core.warning).toHaveBeenCalledOnce();
    }
  });

  it('streams bounded comment pages and keeps only the latest matching marker', async () => {
    const first = {
      id: 20,
      user: { login: 'github-actions[bot]' },
      body: `<!-- gitnexus-review-agent:${PR_NUMBER}:${HEAD_SHA}:${BASE_SHA} -->\nFirst`,
    };
    const latest = { ...first, id: 21, body: `${first.body}\nLatest` };
    const bounded = await runPublisherScenario({
      artifactStatus: 'success',
      commentPages: [[first], [latest]],
    });
    expect(bounded.paginate).toHaveBeenCalledOnce();
    expect(bounded.updateComment).toHaveBeenCalledOnce();
    expect(bounded.updateComment.mock.calls[0]?.[0]).toMatchObject({ comment_id: latest.id });

    const overCap = await runPublisherScenario({
      artifactStatus: 'success',
      commentPages: Array.from({ length: 21 }, () => []),
    });
    expect(overCap.createComment).not.toHaveBeenCalled();
    expect(overCap.updateComment).not.toHaveBeenCalled();
    expect(overCap.core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('exceeded the bounded publication scan'),
    );
  });
});
