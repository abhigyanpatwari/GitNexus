import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { getGitRoot } from '../../storage/git.js';
import type { CiSystem, DetectResult } from './types.js';

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.cs': 'C#',
  '.java': 'Java',
  '.go': 'Go',
  '.rs': 'Rust',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.c': 'C',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
};

async function detectCiSystem(repoRoot: string): Promise<CiSystem | null> {
  const [hasGha, hasAdo] = await Promise.all([
    fs
      .access(path.join(repoRoot, '.github', 'workflows'))
      .then(() => true)
      .catch(() => false),
    fs
      .readdir(repoRoot)
      .then((entries) => entries.some((e) => e.startsWith('azure-pipelines') && e.endsWith('.yml')))
      .catch(() => false),
  ]);
  if (hasGha && hasAdo) return 'both';
  if (hasGha) return 'github-actions';
  if (hasAdo) return 'azure-devops';
  return null;
}

async function detectDocker(repoRoot: string): Promise<boolean> {
  const entries = await fs.readdir(repoRoot).catch(() => [] as string[]);
  return entries.some(
    (e) =>
      e === 'Dockerfile' ||
      e.startsWith('Dockerfile.') ||
      e === 'docker-compose.yml' ||
      e === 'docker-compose.yaml' ||
      e.startsWith('docker-compose.'),
  );
}

async function detectPrimaryLanguage(repoRoot: string): Promise<string> {
  const counts: Record<string, number> = {};
  let scanned = 0;

  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > 3 || scanned > 2000) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.startsWith('.') ||
        entry === 'node_modules' ||
        entry === 'dist' ||
        entry === 'build' ||
        entry === '__pycache__'
      ) {
        continue;
      }
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await scan(full, depth + 1);
      } else {
        scanned++;
        const ext = path.extname(entry).toLowerCase();
        const lang = LANGUAGE_MAP[ext];
        if (lang) counts[lang] = (counts[lang] ?? 0) + 1;
      }
    }
  }

  await scan(repoRoot, 0);

  let top = 'Unknown';
  let max = 0;
  for (const [lang, count] of Object.entries(counts)) {
    if (count > max) {
      max = count;
      top = lang;
    }
  }
  return top;
}

function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function detectEnvironment(cwd: string): Promise<DetectResult> {
  const gitRoot = getGitRoot(cwd);

  if (!gitRoot) {
    return {
      gitRoot: null,
      detectedCi: null,
      hasDocker: false,
      portAvailable: false,
      primaryLanguage: 'Unknown',
    };
  }

  const [detectedCi, hasDocker, portAvailable, primaryLanguage] = await Promise.all([
    detectCiSystem(gitRoot),
    detectDocker(gitRoot),
    checkPortAvailable(4747),
    detectPrimaryLanguage(gitRoot),
  ]);

  return { gitRoot, detectedCi, hasDocker, portAvailable, primaryLanguage };
}
