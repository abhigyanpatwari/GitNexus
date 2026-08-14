import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateHTMLViewer, sanitizeMarkdownForViewer } from '../../src/core/wiki/html-viewer.js';
import {
  createOutputManifest,
  hashOutputContent,
} from '../../src/core/wiki/document/output-manifest.js';
import { resolveLanguage } from '../../src/core/wiki/profiles/locale.js';
import { resolveTemplateProfile } from '../../src/core/wiki/profiles/registry.js';

const tempDirs: string[] = [];

async function tempWiki(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-viewer-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

async function writeManifestWiki(
  wikiDir: string,
  options: { language?: string; tamper?: boolean; maliciousEntry?: string } = {},
): Promise<void> {
  const profile = resolveTemplateProfile('arc42');
  const language = resolveLanguage(options.language ?? 'chinese', profile.profile);
  const generationId = 'generation-1';
  const generationDir = path.join(wikiDir, '.generations', generationId);
  const entry = options.maliciousEntry ?? '# 架构文档\n\n[目标](goals.md)';
  const page = '# 目标\n\n内容';
  const coverage = '{"status":"passed"}\n';
  const manifest = createOutputManifest({
    generationId,
    profile: {
      id: profile.profile.id,
      revision: profile.profile.revision,
      fingerprint: profile.fingerprint,
    },
    language,
    sourceCommit: 'abc123',
    generationSemanticsKey: 'a'.repeat(64),
    entry: {
      slug: 'overview',
      label: language.resolvedLocale === 'zh-CN' ? '架构文档' : 'Architecture',
      file: 'architecture-description.md',
      content: entry,
    },
    pages: [
      {
        id: 'goals',
        slug: 'goals',
        label: language.resolvedLocale === 'zh-CN' ? '目标' : 'Goals',
        file: 'goals.md',
        order: 0,
        status: 'verified',
        content: page,
      },
    ],
    coverage: { file: 'coverage.json', content: coverage },
  });

  await fs.mkdir(generationDir, { recursive: true });
  await fs.mkdir(path.join(wikiDir, '.state'), { recursive: true });
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all([
    fs.writeFile(path.join(generationDir, 'architecture-description.md'), entry),
    fs.writeFile(path.join(generationDir, 'goals.md'), options.tamper ? `${page}\ntampered` : page),
    fs.writeFile(path.join(generationDir, 'coverage.json'), coverage),
    fs.writeFile(path.join(generationDir, 'manifest.json'), manifestJson),
    fs.writeFile(
      path.join(wikiDir, '.state', 'current.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        generationId,
        manifestFile: 'manifest.json',
        manifestHash: hashOutputContent(manifestJson),
        publishedAt: '2026-08-12T00:00:00.000Z',
      })}\n`,
    ),
    fs.writeFile(path.join(wikiDir, 'rogue.md'), '# Must not be embedded'),
  ]);
}

describe('wiki HTML viewer', () => {
  it('keeps the legacy reader compatible while enabling strict browser defenses', async () => {
    const wikiDir = await tempWiki();
    await Promise.all([
      fs.writeFile(
        path.join(wikiDir, 'module_tree.json'),
        JSON.stringify([{ name: 'Core', slug: 'core', files: ['src/core.ts'] }]),
      ),
      fs.writeFile(path.join(wikiDir, 'meta.json'), JSON.stringify({ model: 'model-1' })),
      fs.writeFile(path.join(wikiDir, 'overview.md'), '# Overview'),
      fs.writeFile(
        path.join(wikiDir, 'core.md'),
        '# Core\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))',
      ),
    ]);

    const output = await generateHTMLViewer(wikiDir, 'Legacy');
    const html = await fs.readFile(output, 'utf8');

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("script-src https://cdn.jsdelivr.net 'nonce-gitnexus-wiki'");
    expect(html).toContain('nonce="gitnexus-wiki"');
    expect(html).toContain("securityLevel: 'strict'");
    expect(html).toContain('Overview');
    expect(html).toContain('Modules');
    expect(html).toContain('sanitizeRenderedContent(template.content)');
    expect(html).not.toContain("securityLevel: 'loose'");
    expect(html).not.toContain('<script>alert(1)<\/script>');
  });

  it('uses only hash-verified manifest artifacts and localized fixed UI text', async () => {
    const wikiDir = await tempWiki();
    await writeManifestWiki(wikiDir);

    const output = await generateHTMLViewer(wikiDir, '标准文档');
    const html = await fs.readFile(output, 'utf8');

    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('由 GitNexus 生成');
    expect(html).toContain('"overview":"概览"');
    expect(html).toContain('"modules":"章节"');
    expect(html).toContain('"name":"目标"');
    expect(html).not.toContain('Must not be embedded');
  });

  it('fails closed for a tampered artifact or unsafe current pointer', async () => {
    const tamperedDir = await tempWiki();
    await writeManifestWiki(tamperedDir, { tamper: true });
    await expect(generateHTMLViewer(tamperedDir, 'Tampered')).rejects.toThrow(
      'Wiki artifact hash mismatch: goals.md',
    );

    const unsafeDir = await tempWiki();
    await fs.mkdir(path.join(unsafeDir, '.state'), { recursive: true });
    await fs.writeFile(
      path.join(unsafeDir, '.state', 'current.json'),
      JSON.stringify({
        schemaVersion: 1,
        generationId: '../escape',
        manifestFile: 'manifest.json',
        manifestHash: 'a'.repeat(64),
        publishedAt: '2026-08-12T00:00:00.000Z',
      }),
    );
    await expect(generateHTMLViewer(unsafeDir, 'Unsafe')).rejects.toThrow(
      'Invalid wiki current pointer',
    );

    const pointerDriftDir = await tempWiki();
    await writeManifestWiki(pointerDriftDir);
    const currentPath = path.join(pointerDriftDir, '.state', 'current.json');
    const current = JSON.parse(await fs.readFile(currentPath, 'utf8'));
    current.manifestHash = 'b'.repeat(64);
    await fs.writeFile(currentPath, JSON.stringify(current));
    await expect(generateHTMLViewer(pointerDriftDir, 'Pointer drift')).rejects.toThrow(
      'Wiki current pointer manifest hash mismatch',
    );
  });

  it('escapes raw HTML outside code fences and protects embedded JSON script boundaries', async () => {
    const sanitized = sanitizeMarkdownForViewer(
      '<img src=x onerror=alert(1)>\n```html\n<script>example</script>\n```',
    );
    expect(sanitized).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(sanitized).toContain('<script>example</script>');

    const wikiDir = await tempWiki();
    await writeManifestWiki(wikiDir, {
      maliciousEntry: '# Safe\n\n</script><script>alert(1)</script>',
    });
    const output = await generateHTMLViewer(wikiDir, 'Boundary');
    const html = await fs.readFile(output, 'utf8');
    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');

    const inlineScript = html.match(/<script nonce="gitnexus-wiki">([\s\S]*?)<\/script>/)?.[1];
    expect(inlineScript).toBeDefined();
    expect(() => new Function(inlineScript!)).not.toThrow();
  });

  it('keeps invalid Mermaid readable instead of rendering the Mermaid error SVG', async () => {
    const wikiDir = await tempWiki();
    await writeManifestWiki(wikiDir, {
      maliciousEntry: '# Diagram\n\n```mermaid\ngraph TD; A[broken --> B\n```',
    });

    const output = await generateHTMLViewer(wikiDir, 'Diagram fallback');
    const html = await fs.readFile(output, 'utf8');

    expect(html).toContain('async function renderMermaidBlocks(root)');
    expect(html).toContain("code.className = 'language-mermaid mermaid-error-source'");
    expect(html).toContain('await mermaid.run({ nodes: [block], suppressErrors: true })');
    expect(html).toContain("block.textContent.indexOf('Syntax error in text')");
    expect(html).toContain('if (currentNavigation !== navigationVersion) return');
    expect(html).toContain("console.warn('GitNexus Wiki Mermaid fallback:'");
  });

  it('neutralizes script tag XSS vectors outside code fences', () => {
    const sanitized = sanitizeMarkdownForViewer('<script>alert(1)</script>');
    expect(sanitized).not.toContain('<script>');
    expect(sanitized).not.toContain('</script>');
    expect(sanitized).toContain('&lt;script&gt;');
  });

  it('removes multiline HTML comments that could hide script payloads', () => {
    const sanitized = sanitizeMarkdownForViewer('<!-- multiline\n<script>alert(1)</script>\n-->');
    expect(sanitized).not.toContain('<script>');
    expect(sanitized).not.toContain('alert(1)');
  });

  it('escapes img onerror event handlers', () => {
    const sanitized = sanitizeMarkdownForViewer('<img onerror=alert(1)>');
    expect(sanitized).not.toContain('<img');
    expect(sanitized).toContain('&lt;img onerror=alert(1)&gt;');
  });

  it('handles comment-tag interaction edge cases', () => {
    // 注释与标签交互：整个字符串被当作 HTML 注释删除
    const sanitized = sanitizeMarkdownForViewer('<!--><script>-->');
    expect(sanitized).not.toContain('<script>');

    // 残余标签在注释删除后仍被转义
    const leftover = sanitizeMarkdownForViewer('<!-- safe --><script>alert(1)</script>');
    expect(leftover).not.toContain('<script>');
    expect(leftover).toContain('&lt;script&gt;');
  });
});
