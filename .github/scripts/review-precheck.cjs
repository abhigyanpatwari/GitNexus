// Decide, before the run ends, whether the model's result is publishable.
//
// The acceptance gate runs after the transcript closes, so every rejection used
// to be terminal: a run that produced a stub body or a fabricated citation
// burned its budget and needed a human. This runs the cheap, standalone half of
// those checks immediately after the model returns, so the workflow can hand
// the reason back and let it try once more.
//
// Deliberately NOT re-implemented here: the transcript evidence proof. That
// lives in the assembler, which stays the single authority on acceptance — this
// only decides whether a repair attempt is worth its cost, and a mistake here
// costs one extra turn, never a wrong publication.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIN_BODY_CHARS = 200;

function main() {
  const structuredOutput = process.env.STRUCTURED_OUTPUT || '';
  const outputPath = process.env.GITHUB_OUTPUT;
  const emit = (reason) => {
    fs.appendFileSync(outputPath, `repair_reason<<PRECHECK_EOF\n${reason}\nPRECHECK_EOF\n`);
    if (reason) console.error(`Precheck: ${reason}`);
    else console.log('Precheck: the model result is publishable as returned.');
  };

  let parsed;
  try {
    parsed = JSON.parse(structuredOutput);
  } catch {
    emit('Your result was not valid structured output. Return both fields, body and complete.');
    return;
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    emit('Your structured output was not an object with the fields body and complete.');
    return;
  }
  if (typeof parsed.complete !== 'boolean') {
    emit('Your structured output omitted the boolean field complete.');
    return;
  }
  if (typeof parsed.body !== 'string' || parsed.body.trim().length < MIN_BODY_CHARS) {
    emit(
      'Your body was too short to be a review of this diff. Return the real review: what you ' +
        'checked, what you found, and what you could not cover. A placeholder or status line is ' +
        'not acceptable, and reporting complete: false is not a reason to shorten it.',
    );
    return;
  }

  const { verifyCitations } = require(
    path.join(process.env.GITHUB_WORKSPACE, '.github', 'scripts', 'review-citations.cjs'),
  );
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(
        process.env.RUNNER_TEMP,
        'gitnexus-review-control',
        'review-input',
        'changed-paths.json',
      ),
      'utf8',
    ),
  );
  const citations = verifyCitations(parsed.body, {
    repository: process.env.GITHUB_REPOSITORY,
    headSha: process.env.HEAD_SHA,
    baseSha: process.env.MERGE_BASE_SHA,
    headDir: path.join(process.env.GITHUB_WORKSPACE, 'pr-target'),
    baseDir: path.join(process.env.RUNNER_TEMP, 'gitnexus-review-merge-base'),
    changedPaths: new Set(manifest.head_paths || []),
    basePaths: new Set(manifest.base_paths || []),
  });

  if (citations.invalid.length > 0) {
    const detail = citations.invalid
      .slice(0, 5)
      .map((entry) => `- ${entry.url} ${entry.reason}`)
      .join('\n');
    emit(
      `Your review cited ${citations.invalid.length} location(s) that do not exist at the ` +
        `commits this run analyzed:\n${detail}\nEvery link must point at a real path and a real ` +
        'line at the exact analyzed head or merge-base SHA. Re-read the file before citing it.',
    );
    return;
  }

  emit('');
}

main();
