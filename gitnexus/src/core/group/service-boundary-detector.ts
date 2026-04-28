import fs from 'node:fs/promises';
import path from 'node:path';

export interface ServiceBoundary {
  servicePath: string;
  serviceName: string;
  markers: string[];
  confidence: number;
}

const SERVICE_MARKERS = [
  'package.json',
  'go.mod',
  'Dockerfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'mix.exs',
] as const;

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.py',
  '.pyi',
  '.rs',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.proto',
]);

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'vendor',
  'target',
  'build',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.gradle',
  '.mvn',
  'out',
  'bin',
]);

export async function detectServiceBoundaries(repoPath: string): Promise<ServiceBoundary[]> {
  const boundaries: ServiceBoundary[] = [];
  await walkForBoundaries(repoPath, repoPath, boundaries);
  return boundaries;
}

async function walkForBoundaries(
  dir: string,
  repoRoot: string,
  results: ServiceBoundary[],
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const isRoot = path.resolve(dir) === path.resolve(repoRoot);

  const foundMarkers: string[] = [];
  let hasSourceFiles = false;
  const subdirs: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;

    if (entry.isDirectory()) {
      subdirs.push(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      if (SERVICE_MARKERS.includes(entry.name as (typeof SERVICE_MARKERS)[number])) {
        foundMarkers.push(entry.name);
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_EXTENSIONS.has(ext)) {
        hasSourceFiles = true;
      }
    }
  }

  // Check subdirectories for source files if not found at this level
  if (!hasSourceFiles && foundMarkers.length > 0) {
    hasSourceFiles = await hasSourceFilesInSubdirs(subdirs);
  }

  if (!isRoot && foundMarkers.length >= 1 && hasSourceFiles) {
    const relativePath = path.relative(repoRoot, dir).replace(/\\/g, '/');
    const serviceName = path.basename(dir);
    const confidence = computeConfidence(foundMarkers.length);

    results.push({
      servicePath: relativePath,
      serviceName,
      markers: foundMarkers,
      confidence,
    });
  }

  // Recurse into subdirectories
  for (const subdir of subdirs) {
    await walkForBoundaries(subdir, repoRoot, results);
  }
}

async function hasSourceFilesInSubdirs(subdirs: string[]): Promise<boolean> {
  for (const subdir of subdirs) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(subdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) return true;
      }
      if (entry.isDirectory() && !entry.name.startsWith('.') && !EXCLUDED_DIRS.has(entry.name)) {
        const deeper = await hasSourceFilesInSubdirs([path.join(subdir, entry.name)]);
        if (deeper) return true;
      }
    }
  }
  return false;
}

function computeConfidence(markerCount: number): number {
  if (markerCount >= 3) return 1.0;
  if (markerCount === 2) return 0.9;
  return 0.75;
}

export function assignService(filePath: string, boundaries: ServiceBoundary[]): string | undefined {
  const normalized = filePath.replace(/\\/g, '/');

  let bestMatch: ServiceBoundary | undefined;
  let bestLength = 0;

  for (const boundary of boundaries) {
    const prefix = boundary.servicePath + '/';
    if (normalized.startsWith(prefix) && boundary.servicePath.length > bestLength) {
      bestMatch = boundary;
      bestLength = boundary.servicePath.length;
    }
  }

  return bestMatch?.servicePath;
}
