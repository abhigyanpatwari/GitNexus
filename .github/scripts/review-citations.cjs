// Verify that every location a review cites actually exists.
//
// The evidence gate proves the model queried the graph; it cannot prove the
// prose is about this diff. Citations can: the prompt already requires every
// file/line reference to be a blob link at an exact analyzed SHA, so each one
// is a checkable claim. A cited path that is absent, or a start line past the
// end of the file, is a fabricated location — something a review grounded in
// the real tree structurally cannot produce.
//
// Deliberately NOT an error: citing a file outside the diff. A caller that the
// change breaks is legitimate review material and lives in an unchanged file.
// Grounding is enforced separately, by requiring at least one citation into a
// changed path.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_CITATIONS = 200;
const MAX_FILE_BYTES = 8_000_000;
const SHA_RE = /^[0-9a-f]{40}$/;

function citationPattern(repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `https://github\\.com/${escaped}/blob/([0-9a-f]{40})/([^)\\s#]+)#L(\\d+)(?:-L(\\d+))?`,
    'g',
  );
}

// Resolve inside a checkout without following a symlink out of it. The job
// already rejects escaping symlinks at checkout; this is the second gate.
function resolveInside(rootDir, relativePath) {
  const root = fs.realpathSync(rootDir);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) return undefined;
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined;
  if (stats.size > MAX_FILE_BYTES) return undefined;
  return target;
}

function countLines(filePath) {
  const contents = fs.readFileSync(filePath);
  if (contents.length === 0) return 0;
  let lines = 1;
  for (const byte of contents) if (byte === 0x0a) lines += 1;
  // A trailing newline does not start a further line.
  if (contents[contents.length - 1] === 0x0a) lines -= 1;
  return lines;
}

/**
 * @param {string} body Markdown review body.
 * @param {{repository: string, headSha: string, baseSha: string,
 *          headDir: string, baseDir: string,
 *          changedPaths: Set<string>, basePaths: Set<string>}} options
 */
function verifyCitations(body, options) {
  const { repository, headSha, baseSha, headDir, baseDir, changedPaths, basePaths } = options;
  if (!SHA_RE.test(headSha) || !SHA_RE.test(baseSha)) {
    throw new Error('citation verification needs two exact SHAs');
  }

  const result = { checked: 0, valid: 0, grounded: 0, invalid: [], truncated: false };
  const seen = new Set();

  for (const match of body.matchAll(citationPattern(repository))) {
    const [url, sha, citedPath, startText, endText] = match;
    if (seen.has(url)) continue;
    seen.add(url);
    if (result.checked >= MAX_CITATIONS) {
      result.truncated = true;
      break;
    }
    result.checked += 1;

    const isHead = sha === headSha;
    const isBase = sha === baseSha;
    if (!isHead && !isBase) {
      // The prompt names exactly two SHAs; anything else is a location this
      // run never analyzed.
      result.invalid.push({ url, reason: 'cites a commit that was not analyzed' });
      continue;
    }

    const decodedPath = decodeURIComponent(citedPath);
    const resolved = resolveInside(isHead ? headDir : baseDir, decodedPath);
    if (!resolved) {
      result.invalid.push({ url, reason: 'cites a path that does not exist at that commit' });
      continue;
    }

    const startLine = Number(startText);
    const lineCount = countLines(resolved);
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > lineCount) {
      result.invalid.push({
        url,
        reason: `cites line ${startText} of a ${lineCount}-line file`,
      });
      continue;
    }
    // An end line past EOF is sloppy, not fabricated: the start anchors the
    // claim and the reader lands in the right place.
    if (endText !== undefined && Number(endText) < startLine) {
      result.invalid.push({ url, reason: 'cites an inverted line range' });
      continue;
    }

    result.valid += 1;
    const grounded = isHead ? changedPaths.has(decodedPath) : basePaths.has(decodedPath);
    if (grounded) result.grounded += 1;
  }

  return result;
}

module.exports = { verifyCitations, MAX_CITATIONS };
