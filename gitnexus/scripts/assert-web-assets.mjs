#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const webDir = path.resolve(process.argv[2] ?? 'web');
const indexPath = path.join(webDir, 'index.html');

let html;
try {
  html = fs.readFileSync(indexPath, 'utf8');
} catch (err) {
  if (err?.code === 'ENOENT') {
    console.error(`[web-assets] missing ${indexPath}`);
    process.exit(1);
  }
  throw err;
}
const localRefs = [...html.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)]
  .map((match) => match[1])
  .filter((ref) => !/^(?:[a-z]+:|\/\/|data:)/i.test(ref))
  .map((ref) => ref.split(/[?#]/, 1)[0].replace(/^\/+/, ''));
const assetRefs = localRefs.filter((ref) => ref.startsWith('assets/'));

if (assetRefs.length === 0) {
  console.error(`[web-assets] ${indexPath} references no assets`);
  process.exit(1);
}

const missing = assetRefs.filter((ref) => !fs.existsSync(path.join(webDir, ref)));
if (missing.length > 0) {
  console.error(`[web-assets] ${indexPath} references missing assets:\n${missing.join('\n')}`);
  process.exit(1);
}

console.log(`[web-assets] verified index.html and ${assetRefs.length} referenced asset(s)`);
