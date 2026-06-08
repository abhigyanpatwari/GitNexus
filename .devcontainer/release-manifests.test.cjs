'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

test('Claude plugin manifests track the current gitnexus release version', () => {
  const gitnexusPkg = readJson('gitnexus/package.json');
  const pluginManifest = readJson('gitnexus-claude-plugin/.claude-plugin/plugin.json');
  const marketplaceManifest = readJson('.claude-plugin/marketplace.json');
  const gitnexusMarketplaceEntry = marketplaceManifest.plugins.find((plugin) => plugin.name === 'gitnexus');

  assert.ok(gitnexusMarketplaceEntry, 'expected gitnexus marketplace entry');
  assert.equal(pluginManifest.version, gitnexusPkg.version);
  assert.equal(gitnexusMarketplaceEntry.version, gitnexusPkg.version);
});
