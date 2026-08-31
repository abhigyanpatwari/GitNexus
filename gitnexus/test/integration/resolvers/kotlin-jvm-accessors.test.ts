/**
 * Production-path Kotlin JVM accessor synthesis.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  writeFixtureRepo,
  runPipelineFromRepo,
  getRelationships,
  getNodesByLabelFull,
} from './helpers.js';

describe('Kotlin JVM accessor synthesis (pipeline)', () => {
  it('emits generated and custom getters and resolves same-language calls', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-kt-jvm-acc-'));
    try {
      writeFixtureRepo(root, {
        'User.kt': `data class User(val name: String) {
  val display: String get() = name
}
fun read(user: User): String = user.getName()
fun readDisplay(user: User): String = user.getDisplay()
`,
      });
      const linked = await runPipelineFromRepo(root, () => {});
      const getName = getNodesByLabelFull(linked, 'Method').find(
        (m) => m.name === 'getName' && m.properties.filePath.endsWith('User.kt'),
      );
      expect(getName).toBeDefined();
      expect(getName?.properties).toMatchObject({
        parameterCount: 0,
        returnType: 'String',
        synthetic: 'kotlin-jvm',
        qualifiedName: 'User.getName',
      });
      const hasMethod = getRelationships(linked, 'HAS_METHOD').filter(
        (e) => e.source === 'User' && e.target === 'getName',
      );
      expect(hasMethod.length).toBeGreaterThanOrEqual(1);
      const calls = getRelationships(linked, 'CALLS').filter(
        (e) => e.source === 'read' && e.target === 'getName',
      );
      expect(calls.some((e) => e.targetFilePath.endsWith('User.kt'))).toBe(true);
      const getDisplay = getNodesByLabelFull(linked, 'Method').find(
        (m) => m.name === 'getDisplay' && m.properties.filePath.endsWith('User.kt'),
      );
      expect(getDisplay?.properties).toMatchObject({
        returnType: 'String',
        synthetic: 'kotlin-jvm',
        qualifiedName: 'User.getDisplay',
      });
      const displayCalls = getRelationships(linked, 'CALLS').filter(
        (e) => e.source === 'readDisplay' && e.target === 'getDisplay',
      );
      expect(displayCalls.some((e) => e.targetFilePath.endsWith('User.kt'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('resolves same-named synthetic accessors to the receiver class', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-kt-jvm-owner-'));
    try {
      writeFixtureRepo(root, {
        'Models.kt': `class Alpha(val name: String)
class Beta(val name: String)
fun readAlpha(alpha: Alpha): String = alpha.getName()
fun readBeta(beta: Beta): String = beta.getName()
`,
      });
      const linked = await runPipelineFromRepo(root, () => {});
      const ownerByMethod = new Map(
        getRelationships(linked, 'HAS_METHOD').map((edge) => [edge.rel.targetId, edge.source]),
      );
      const calls = getRelationships(linked, 'CALLS').filter((edge) => edge.target === 'getName');
      const alphaCall = calls.find((edge) => edge.source === 'readAlpha');
      const betaCall = calls.find((edge) => edge.source === 'readBeta');
      expect(alphaCall).toBeDefined();
      expect(betaCall).toBeDefined();
      expect(ownerByMethod.get(alphaCall?.rel.targetId ?? '')).toBe('Alpha');
      expect(ownerByMethod.get(betaCall?.rel.targetId ?? '')).toBe('Beta');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('emits Kotlin getName while Java-to-Kotlin member CALLS remains unsupported', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-kt-acc-'));
    try {
      writeFixtureRepo(root, {
        'models/User.kt': `package models
data class User(val name: String)
`,
        'app/Consumer.java': `package app;
import models.User;
class Consumer {
  String consume(User user) {
    return user.getName();
  }
}
`,
      });
      const linked = await runPipelineFromRepo(root, () => {});
      const getName = getNodesByLabelFull(linked, 'Method').find(
        (m) => m.name === 'getName' && String(m.properties.filePath).endsWith('User.kt'),
      );
      expect(getName).toBeDefined();
      const calls = getRelationships(linked, 'CALLS').filter(
        (e) => e.source === 'consume' && e.target === 'getName',
      );
      // Pre-existing cross-language resolver gap: this feature adds the target
      // Method but does not claim Java→Kotlin member CALLS support.
      expect(getName?.properties.synthetic).toBe('kotlin-jvm');
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
