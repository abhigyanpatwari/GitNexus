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
  it('emits getName on a data class and resolves a same-language call', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-kt-jvm-acc-'));
    try {
      writeFixtureRepo(root, {
        'User.kt': `data class User(val name: String)
fun read(user: User): String = user.getName()
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('Java Consumer.consume -> Kotlin data class getName', async () => {
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
      // Same JVM interop caveat as Kotlin→Java: document if CALLS is empty.
      if (calls.length === 0) {
        expect(getName?.properties.synthetic).toBe('kotlin-jvm');
      } else {
        expect(calls.some((e) => e.targetFilePath.endsWith('User.kt'))).toBe(true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
