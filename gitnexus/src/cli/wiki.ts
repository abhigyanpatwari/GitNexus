/**
 * Wiki Command
 * 
 * Generates repository documentation from the knowledge graph.
 * Usage: gitnexus wiki [path] [options]
 */

import path from 'path';
import readline from 'readline';
import { execSync, execFileSync } from 'child_process';
import cliProgress from 'cli-progress';
import { getGitRoot, isGitRepo } from '../storage/git.js';
import { getStoragePaths, loadMeta, loadCLIConfig, saveCLIConfig } from '../storage/repo-manager.js';
import { WikiGenerator, type WikiOptions } from '../core/wiki/generator.js';
import { resolveLLMConfig } from '../core/wiki/llm-client.js';

export interface WikiCommandOptions {
  force?: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  concurrency?: string;
  gist?: boolean;
}

/**
 * Provider presets for common LLM endpoints.
 * Each preset defines a base URL and sensible default model.
 */
const PROVIDER_PRESETS: Record<string, { baseUrl: string; model: string; needsKey: boolean }> = {
  openai:      { baseUrl: 'https://api.openai.com/v1',      model: 'gpt-4o-mini',           needsKey: true },
  openrouter:  { baseUrl: 'https://openrouter.ai/api/v1',   model: 'minimax/minimax-m2.5',  needsKey: true },
  deepseek:    { baseUrl: 'https://api.deepseek.com/v1',    model: 'deepseek-chat',         needsKey: true },
  ollama:      { baseUrl: 'http://localhost:11434/v1',       model: 'llama3.2',              needsKey: false },
  lmstudio:    { baseUrl: 'http://localhost:1234/v1',        model: 'default',               needsKey: false },
};

/**
 * Resolve provider preset. If the provider string isn't a known preset,
 * treat it as a custom base URL.
 */
function resolveProvider(provider: string): { baseUrl: string; model: string; needsKey: boolean } {
  const preset = PROVIDER_PRESETS[provider.toLowerCase()];
  if (preset) return preset;
  // Treat unknown provider as a custom base URL
  return { baseUrl: provider, model: 'gpt-4o-mini', needsKey: true };
}

/**
 * Prompt the user for input via stdin.
 */
function prompt(question: string, hide = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (hide && process.stdin.isTTY) {
      // Mask input for API keys
      process.stdout.write(question);
      let input = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf-8');

      const onData = (char: string) => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '\u0003') {
          // Ctrl+C
          process.stdin.setRawMode(false);
          rl.close();
          process.exit(1);
        } else if (char === '\u007F' || char === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += char;
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

export const wikiCommand = async (
  inputPath?: string,
  options?: WikiCommandOptions,
) => {
  console.log('\n  GitNexus Wiki Generator\n');

  // ── Resolve repo path ───────────────────────────────────────────────
  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      console.log('  Error: Not inside a git repository\n');
      process.exitCode = 1;
      return;
    }
    repoPath = gitRoot;
  }

  if (!isGitRepo(repoPath)) {
    console.log('  Error: Not a git repository\n');
    process.exitCode = 1;
    return;
  }

  // ── Check for existing index ────────────────────────────────────────
  const { storagePath, kuzuPath } = getStoragePaths(repoPath);
  const meta = await loadMeta(storagePath);

  if (!meta) {
    console.log('  Error: No GitNexus index found.');
    console.log('  Run `gitnexus analyze` first to index this repository.\n');
    process.exitCode = 1;
    return;
  }

  // ── Resolve LLM config (with interactive fallback) ─────────────────
  // Resolve --provider preset into baseUrl/model defaults
  let providerDefaults: { baseUrl?: string; model?: string; needsKey?: boolean } = {};
  if (options?.provider) {
    providerDefaults = resolveProvider(options.provider);
    console.log(`  Provider: ${options.provider} → ${providerDefaults.baseUrl}\n`);
  }

  // CLI flags override provider defaults
  const effectiveBaseUrl = options?.baseUrl || providerDefaults.baseUrl;
  const effectiveModel = options?.model || providerDefaults.model;

  // Save any CLI overrides immediately
  if (options?.apiKey || effectiveModel || effectiveBaseUrl) {
    const existing = await loadCLIConfig();
    const updates: Record<string, string> = {};
    if (options?.apiKey) updates.apiKey = options.apiKey;
    if (effectiveModel) updates.model = effectiveModel;
    if (effectiveBaseUrl) updates.baseUrl = effectiveBaseUrl;
    await saveCLIConfig({ ...existing, ...updates });
    console.log('  Config saved to ~/.gitnexus/config.json\n');
  }

  const savedConfig = await loadCLIConfig();
  const hasSavedConfig = !!(savedConfig.apiKey && savedConfig.baseUrl);
  const hasCLIOverrides = !!(options?.apiKey || options?.provider || options?.model || options?.baseUrl);

  let llmConfig = await resolveLLMConfig({
    model: effectiveModel,
    baseUrl: effectiveBaseUrl,
    apiKey: options?.apiKey,
  });

  // Run interactive setup if no saved config and no CLI flags provided
  // (even if env vars exist — let user explicitly choose their provider)
  if (!hasSavedConfig && !hasCLIOverrides) {
    if (!process.stdin.isTTY) {
      if (!llmConfig.apiKey) {
        console.log('  Error: No LLM API key found.');
        console.log('  Options:');
        console.log('    --provider ollama          (local, no key needed)');
        console.log('    --provider deepseek --api-key <key>');
        console.log('    --provider openrouter --api-key <key>');
        console.log('    OPENAI_API_KEY=... or GITNEXUS_API_KEY=...\n');
        process.exitCode = 1;
        return;
      }
      // Non-interactive with env var — just use it
    } else {
      console.log('  No LLM configured. Let\'s set it up.\n');
      console.log('  Supports any OpenAI-compatible API (OpenAI, DeepSeek, Ollama, etc.)\n');

      // Provider selection
      console.log('  [1] OpenAI          (api.openai.com)');
      console.log('  [2] OpenRouter      (openrouter.ai — 300+ models)');
      console.log('  [3] DeepSeek        (api.deepseek.com)');
      console.log('  [4] Ollama          (localhost:11434 — local, no key needed)');
      console.log('  [5] LM Studio       (localhost:1234 — local, no key needed)');
      console.log('  [6] Custom endpoint\n');

      const choice = await prompt('  Select provider (1-6): ');

      let baseUrl: string;
      let defaultModel: string;
      let needsKey = true;

      const presetMap: Record<string, string> = {
        '1': 'openai', '2': 'openrouter', '3': 'deepseek',
        '4': 'ollama', '5': 'lmstudio',
      };

      if (presetMap[choice]) {
        const preset = PROVIDER_PRESETS[presetMap[choice]];
        baseUrl = preset.baseUrl;
        defaultModel = preset.model;
        needsKey = preset.needsKey;
      } else if (choice === '6') {
        baseUrl = await prompt('  Base URL (e.g. http://localhost:18789/v1): ');
        if (!baseUrl) {
          console.log('\n  No URL provided. Aborting.\n');
          process.exitCode = 1;
          return;
        }
        defaultModel = 'gpt-4o-mini';
        const keyNeeded = await prompt('  Does this endpoint require an API key? (Y/n): ');
        needsKey = !keyNeeded || keyNeeded.toLowerCase() === 'y' || keyNeeded.toLowerCase() === 'yes';
      } else {
        baseUrl = 'https://api.openai.com/v1';
        defaultModel = 'gpt-4o-mini';
      }

      // Model
      const modelInput = await prompt(`  Model (default: ${defaultModel}): `);
      const model = modelInput || defaultModel;

      // API key — skip for local providers that don't need one
      let key = '';
      if (needsKey) {
        const envKey = process.env.GITNEXUS_API_KEY || process.env.OPENAI_API_KEY || '';
        if (envKey) {
          const masked = envKey.slice(0, 6) + '...' + envKey.slice(-4);
          const useEnv = await prompt(`  Use existing env key (${masked})? (Y/n): `);
          if (!useEnv || useEnv.toLowerCase() === 'y' || useEnv.toLowerCase() === 'yes') {
            key = envKey;
          } else {
            key = await prompt('  API key: ', true);
          }
        } else {
          key = await prompt('  API key: ', true);
        }

        if (!key) {
          console.log('\n  No key provided. Aborting.\n');
          process.exitCode = 1;
          return;
        }
      } else {
        console.log('  No API key needed for local provider.\n');
        key = 'local';
      }

      // Save
      await saveCLIConfig({ apiKey: key, baseUrl, model });
      console.log('  Config saved to ~/.gitnexus/config.json\n');

      llmConfig = { ...llmConfig, apiKey: key, baseUrl, model };
    }
  }

  // ── Setup progress bar with elapsed timer ──────────────────────────
  const bar = new cliProgress.SingleBar({
    format: '  {bar} {percentage}% | {phase}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    barGlue: '',
    autopadding: true,
    clearOnComplete: false,
    stopOnComplete: false,
  }, cliProgress.Presets.shades_grey);

  bar.start(100, 0, { phase: 'Initializing...' });

  const t0 = Date.now();
  let lastPhase = '';
  let phaseStart = t0;

  // Tick elapsed time every second while stuck on the same phase
  const elapsedTimer = setInterval(() => {
    if (lastPhase) {
      const elapsed = Math.round((Date.now() - phaseStart) / 1000);
      if (elapsed >= 3) {
        bar.update({ phase: `${lastPhase} (${elapsed}s)` });
      }
    }
  }, 1000);

  // ── Run generator ───────────────────────────────────────────────────
  const wikiOptions: WikiOptions = {
    force: options?.force,
    model: options?.model,
    baseUrl: options?.baseUrl,
    concurrency: options?.concurrency ? parseInt(options.concurrency, 10) : undefined,
  };

  const generator = new WikiGenerator(
    repoPath,
    storagePath,
    kuzuPath,
    llmConfig,
    wikiOptions,
    (phase, percent, detail) => {
      const label = detail || phase;
      if (label !== lastPhase) {
        lastPhase = label;
        phaseStart = Date.now();
      }
      bar.update(percent, { phase: label });
    },
  );

  try {
    const result = await generator.run();

    clearInterval(elapsedTimer);
    bar.update(100, { phase: 'Done' });
    bar.stop();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    const wikiDir = path.join(storagePath, 'wiki');
    const viewerPath = path.join(wikiDir, 'index.html');

    if (result.mode === 'up-to-date' && !options?.force) {
      console.log('\n  Wiki is already up to date.');
      console.log(`  Viewer: ${viewerPath}\n`);
      await maybePublishGist(viewerPath, options?.gist);
      return;
    }

    console.log(`\n  Wiki generated successfully (${elapsed}s)\n`);
    console.log(`  Mode: ${result.mode}`);
    console.log(`  Pages: ${result.pagesGenerated}`);
    console.log(`  Output: ${wikiDir}`);
    console.log(`  Viewer: ${viewerPath}`);

    if (result.failedModules && result.failedModules.length > 0) {
      console.log(`\n  Failed modules (${result.failedModules.length}):`);
      for (const mod of result.failedModules) {
        console.log(`    - ${mod}`);
      }
      console.log('  Re-run to retry failed modules (pages will be regenerated).');
    }

    console.log('');

    await maybePublishGist(viewerPath, options?.gist);
  } catch (err: any) {
    clearInterval(elapsedTimer);
    bar.stop();

    if (err.message?.includes('No source files')) {
      console.log(`\n  ${err.message}\n`);
    } else if (err.message?.includes('API key') || err.message?.includes('API error')) {
      console.log(`\n  LLM Error: ${err.message}\n`);

      // Offer to reconfigure on auth-related failures
      const isAuthError = err.message?.includes('401') || err.message?.includes('403')
        || err.message?.includes('502') || err.message?.includes('authenticate')
        || err.message?.includes('Unauthorized');
      if (isAuthError && process.stdin.isTTY) {
        const answer = await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question('  Reconfigure LLM settings? (Y/n): ', (ans) => { rl.close(); resolve(ans.trim().toLowerCase()); });
        });
        if (!answer || answer === 'y' || answer === 'yes') {
          // Clear saved config so next run triggers interactive setup
          await saveCLIConfig({});
          console.log('  Config cleared. Run `gitnexus wiki` again to reconfigure.\n');
        }
      }
    } else {
      console.log(`\n  Error: ${err.message}\n`);
      if (process.env.DEBUG) {
        console.error(err);
      }
    }
    process.exitCode = 1;
  }
};

// ─── Gist Publishing ───────────────────────────────────────────────────

function hasGhCLI(): boolean {
  try {
    execSync('gh --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function publishGist(htmlPath: string): { url: string; rawUrl: string } | null {
  try {
    const output = execFileSync('gh', [
      'gist', 'create', htmlPath,
      '--desc', 'Repository Wiki — generated by GitNexus',
      '--public',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

    // gh gist create prints the gist URL as the last line
    const lines = output.split('\n');
    const gistUrl = lines.find(l => l.includes('gist.github.com')) || lines[lines.length - 1];

    if (!gistUrl || !gistUrl.includes('gist.github.com')) return null;

    // Build a raw viewer URL via gist.githack.com
    // gist URL format: https://gist.github.com/{user}/{id}
    const match = gistUrl.match(/gist\.github\.com\/([^/]+)\/([a-f0-9]+)/);
    let rawUrl = gistUrl;
    if (match) {
      rawUrl = `https://gistcdn.githack.com/${match[1]}/${match[2]}/raw/index.html`;
    }

    return { url: gistUrl.trim(), rawUrl };
  } catch {
    return null;
  }
}

async function maybePublishGist(htmlPath: string, gistFlag?: boolean): Promise<void> {
  if (gistFlag === false) return;

  // Check that the HTML file exists
  try {
    const fs = await import('fs/promises');
    await fs.access(htmlPath);
  } catch {
    return;
  }

  if (!hasGhCLI()) {
    if (gistFlag) {
      console.log('  GitHub CLI (gh) is not installed. Cannot publish gist.');
      console.log('  Install it: https://cli.github.com\n');
    }
    return;
  }

  let shouldPublish = !!gistFlag;

  if (!shouldPublish && process.stdin.isTTY) {
    const answer = await new Promise<string>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('  Publish wiki as a GitHub Gist for easy viewing? (Y/n): ', (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });
    shouldPublish = !answer || answer === 'y' || answer === 'yes';
  }

  if (!shouldPublish) return;

  console.log('\n  Publishing to GitHub Gist...');
  const result = publishGist(htmlPath);

  if (result) {
    console.log(`  Gist:   ${result.url}`);
    console.log(`  Viewer: ${result.rawUrl}\n`);
  } else {
    console.log('  Failed to publish gist. Make sure `gh auth login` is configured.\n');
  }
}
