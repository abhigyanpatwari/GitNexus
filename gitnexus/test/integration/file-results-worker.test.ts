import { describe, it } from 'vitest';
import {
  withCacheKeys,
  assertDispatchFrame,
  assertBatchedFileResults,
} from '../helpers/worker-file-results.js';
const files = withCacheKeys([
  {
    path: 'a.ts',
    content:
      'export class A { method() { return 1; } } export function call() { return new A().method(); }',
  },
  {
    path: 'b.ts',
    content: 'export const n = 2; export function other(value: number) { return value + n; }',
  },
  { path: 'view.tsx', content: 'export function View() { return <div>hello</div>; }' },
  {
    path: 'api.py',
    content:
      'from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/items")\ndef items():\n    return []\n',
  },
  {
    path: 'main.go',
    content: 'package main\nfunc first() int { return second() }\nfunc second() int { return 2 }\n',
  },
  { path: 'empty.ts', content: '' },
]);
describe('file-local output within batched worker jobs', () => {
  it('retains per-file keys in zero-copy dispatch messages', () => assertDispatchFrame(files));
  it.each([false, true])(
    'matches ordinary worker output with PDG=%s and multiple workers',
    async (pdg) => assertBatchedFileResults(files, pdg),
    60000,
  );
});
