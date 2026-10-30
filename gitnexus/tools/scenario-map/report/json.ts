/** Report JSON can exceed V8's single-string limit. Keep I/O bounded by individual records. */
import { JSONParser } from '@streamparser/json';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isRecord } from '../util.js';
import type { ScenarioMapReport } from './report.js';

/** Report collections (pairs, tests, anchors, etc.) are serialized one entry at a time. */
function* jsonChunks(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) yield ',\n';
      yield JSON.stringify(value[i]) ?? 'null';
    }
    yield ']';
  } else if (isRecord(value)) {
    yield '{';
    let first = true;
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) continue;
      if (!first) yield ',\n';
      first = false;
      yield `${JSON.stringify(key)}:`;
      yield* jsonChunks(member);
    }
    yield '}';
  } else {
    yield JSON.stringify(value) ?? 'null';
  }
}

/** Same report schema, without constructing a single string or publishing a truncated file. */
export async function writeReportJson(file: string, report: ScenarioMapReport): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await pipeline(
      Readable.from(jsonChunks(report), { objectMode: false }),
      createWriteStream(temporary, { flags: 'wx' }),
    );
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Read selected top-level fields, validating the entire document but retaining only those fields.
 * Baseline comparison needs schemaVersion/run/continuity; issue publication needs run/completeness.
 * Values remain unknown so existing readers can validate old or incompatible report schemas.
 */
export async function readReportFields(
  file: string,
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  const selected = new Set(fields);
  const result: Record<string, unknown> = Object.create(null);
  const parser = new JSONParser({
    paths: fields.map((field) => `$.${field}`),
    keepStack: false,
    stringBufferSize: 64 * 1024,
  });
  let hasToken = false;
  parser.onToken = () => {
    hasToken = true;
  };
  parser.onValue = ({ key, value }) => {
    if (typeof key === 'string' && selected.has(key)) result[key] = value;
  };
  for await (const chunk of createReadStream(file)) parser.write(chunk);
  if (!parser.isEnded) parser.end();
  if (!hasToken) throw new SyntaxError('Empty report JSON');
  return result;
}
