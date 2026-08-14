/**
 * HTML Viewer Generator for Wiki
 *
 * Produces a self-contained index.html that embeds all markdown pages,
 * module tree, and metadata — viewable offline in any browser.
 */

import fs from 'fs/promises';
import path from 'path';
import { sanitizeMermaidMarkdown } from './mermaid-sanitizer.js';
import {
  hashOutputContent,
  validateOutputManifest,
  type OutputManifest,
} from './document/output-manifest.js';
import { getWikiPresentationMessages, type WikiPresentationMessages } from './profiles/locale.js';
import type { ResolvedLanguage } from './profiles/types.js';

interface ModuleTreeNode {
  name: string;
  slug: string;
  files: string[];
  children?: ModuleTreeNode[];
}

interface ViewerData {
  tree: ModuleTreeNode[];
  pages: Record<string, string>;
  meta: Record<string, unknown> | null;
  language: ResolvedLanguage;
  messages: WikiPresentationMessages;
}

const LEGACY_LANGUAGE: ResolvedLanguage = {
  requestedLanguage: '',
  resolvedLocale: 'en',
  localeFingerprint: 'legacy',
  localeResolverVersion: 0,
  diagnostics: [],
};

export function sanitizeMarkdownForViewer(markdown: string): string {
  const mermaidSafe = sanitizeMermaidMarkdown(markdown);
  // 先对完整字符串删除 HTML 注释（可跨行），再清除残留的注释标记片段，最后按行处理围栏和标签
  const commentRemoved = mermaidSafe
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--|-->/g, '');
  let inFence = false;
  return commentRemoved
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // 转义所有 HTML 标签为实体（非围栏行不需要原始 HTML）
      return line.replace(/<\/?[a-zA-Z/][^>]*>/g, (tag) =>
        tag.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      );
    })
    .join('\n');
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readManifestData(wikiDir: string): Promise<ViewerData | null> {
  const currentPath = path.join(wikiDir, '.state', 'current.json');
  let currentRaw: string;
  let current: unknown;
  try {
    currentRaw = await fs.readFile(currentPath, 'utf8');
    current = JSON.parse(currentRaw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Invalid wiki current pointer: ${(error as Error).message}`);
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('Invalid wiki current pointer');
  }
  const pointer = current as Record<string, unknown>;
  const unknownPointerKeys = Object.keys(pointer).filter(
    (key) =>
      ![
        'schemaVersion',
        'generationId',
        'manifestFile',
        'manifestHash',
        'publishedAt',
        'previousGenerationId',
      ].includes(key),
  );
  if (
    unknownPointerKeys.length > 0 ||
    pointer.schemaVersion !== 1 ||
    pointer.manifestFile !== 'manifest.json' ||
    typeof pointer.generationId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(pointer.generationId) ||
    typeof pointer.manifestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(pointer.manifestHash) ||
    typeof pointer.publishedAt !== 'string' ||
    (pointer.previousGenerationId !== undefined &&
      (typeof pointer.previousGenerationId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(pointer.previousGenerationId)))
  ) {
    throw new Error('Invalid wiki current pointer');
  }
  const generationId = pointer.generationId;
  const generationDir = path.join(wikiDir, '.generations', generationId);
  const manifestRaw = await fs.readFile(path.join(generationDir, 'manifest.json'), 'utf8');
  if (hashOutputContent(manifestRaw) !== pointer.manifestHash) {
    throw new Error('Wiki current pointer manifest hash mismatch');
  }
  const manifest = JSON.parse(manifestRaw) as OutputManifest;
  validateOutputManifest(manifest);
  if (manifest.generationId !== generationId) {
    throw new Error('Wiki manifest generationId does not match current pointer');
  }

  const pages: Record<string, string> = {};
  const artifacts = [manifest.entry, ...manifest.pages];
  for (const artifact of artifacts) {
    const content = await fs.readFile(path.join(generationDir, artifact.file), 'utf8');
    if (hashOutputContent(content) !== artifact.contentHash) {
      throw new Error(`Wiki artifact hash mismatch: ${artifact.file}`);
    }
    pages[artifact.slug] = sanitizeMarkdownForViewer(content);
  }

  const byParent = new Map<string | undefined, OutputManifest['pages']>();
  for (const page of [...manifest.pages].sort((a, b) => a.order - b.order)) {
    const siblings = byParent.get(page.parentId) ?? [];
    siblings.push(page);
    byParent.set(page.parentId, siblings);
  }
  const buildTree = (parentId?: string): ModuleTreeNode[] =>
    (byParent.get(parentId) ?? []).map((page) => ({
      name: page.label,
      slug: page.slug,
      files: [],
      ...(byParent.has(page.id) ? { children: buildTree(page.id) } : {}),
    }));

  let meta: Record<string, unknown> | null = null;
  try {
    meta = (await readJson(path.join(generationDir, 'meta.json'))) as Record<string, unknown>;
  } catch {
    /* Viewer 渲染不强制要求 meta */
  }
  const presentationLanguage =
    manifest.profile.id === 'default' ? LEGACY_LANGUAGE : manifest.language;
  return {
    tree: buildTree(),
    pages,
    meta,
    language: presentationLanguage,
    messages: getWikiPresentationMessages(presentationLanguage),
  };
}

async function readLegacyData(wikiDir: string): Promise<ViewerData> {
  let tree: ModuleTreeNode[] = [];
  try {
    tree = (await readJson(path.join(wikiDir, 'module_tree.json'))) as ModuleTreeNode[];
  } catch {
    /* will show empty nav */
  }

  let meta: Record<string, unknown> | null = null;
  try {
    meta = (await readJson(path.join(wikiDir, 'meta.json'))) as Record<string, unknown>;
  } catch {
    /* no meta */
  }

  const pages: Record<string, string> = {};
  const dirEntries = await fs.readdir(wikiDir);
  for (const file of dirEntries.filter((entry) => entry.endsWith('.md'))) {
    const content = await fs.readFile(path.join(wikiDir, file), 'utf8');
    pages[file.replace(/\.md$/, '')] = sanitizeMarkdownForViewer(content);
  }
  return {
    tree,
    pages,
    meta,
    language: LEGACY_LANGUAGE,
    messages: getWikiPresentationMessages(LEGACY_LANGUAGE),
  };
}

/**
 * 根据已有 Markdown 页面生成 Wiki HTML Viewer（index.html）。
 */
export async function generateHTMLViewer(wikiDir: string, projectName: string): Promise<string> {
  const data = (await readManifestData(wikiDir)) ?? (await readLegacyData(wikiDir));
  const html = buildHTML(projectName, data);
  const outputPath = path.join(wikiDir, 'index.html');
  await fs.writeFile(outputPath, html, 'utf-8');
  return outputPath;
}

// ─── HTML Builder ───────────────────────────────────────────────────────

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHTML(projectName: string, data: ViewerData): string {
  // Embed data as JSON inside the HTML.
  // Escape </script> sequences so they don't prematurely close the <script> tag.
  const escScript = (s: string) => s.replace(/<\//g, '<\\/');
  const pagesJSON = escScript(JSON.stringify(data.pages));
  const treeJSON = escScript(JSON.stringify(data.tree));
  const metaJSON = escScript(JSON.stringify(data.meta));
  const messagesJSON = escScript(JSON.stringify(data.messages));

  const parts: string[] = [];

  // ── Head ──
  parts.push('<!DOCTYPE html>');
  parts.push(`<html lang="${data.language.resolvedLocale}">`);
  parts.push('<head>');
  parts.push('<meta charset="UTF-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
  parts.push(
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src https://cdn.jsdelivr.net 'nonce-gitnexus-wiki'; style-src 'unsafe-inline'; img-src https: data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">",
  );
  parts.push('<title>' + esc(projectName) + ' — Wiki</title>');
  parts.push('<script src="https://cdn.jsdelivr.net/npm/marked@11.0.0/marked.min.js"><\/script>');
  parts.push(
    '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>',
  );
  parts.push('<style>');
  parts.push(CSS);
  parts.push('</style>');
  parts.push('</head>');

  // ── Body ──
  parts.push('<body>');
  parts.push(
    '<button class="menu-toggle" id="menu-toggle" aria-label="Toggle menu">&#9776;</button>',
  );
  parts.push('<div class="layout">');

  // Sidebar
  parts.push('<nav class="sidebar" id="sidebar">');
  parts.push('<div class="sidebar-header">');
  parts.push('<div class="sidebar-title">');
  parts.push(BOOK_SVG);
  parts.push(esc(projectName));
  parts.push('</div>');
  parts.push('<div class="sidebar-meta" id="meta-info"></div>');
  parts.push('</div>');
  parts.push('<div id="nav-tree"></div>');
  parts.push(`<div class="sidebar-footer">${esc(data.messages.generatedBy)}</div>`);
  parts.push('</nav>');

  // Content
  parts.push('<main class="content" id="content">');
  parts.push(`<div class="empty-state"><h2>${esc(data.messages.loading)}</h2></div>`);
  parts.push('</main>');
  parts.push('</div>');

  // ── Script ──
  parts.push('<script nonce="gitnexus-wiki">');
  parts.push('var PAGES = ' + pagesJSON + ';');
  parts.push('var TREE = ' + treeJSON + ';');
  parts.push('var META = ' + metaJSON + ';');
  parts.push('var MESSAGES = ' + messagesJSON + ';');
  parts.push(JS_APP);
  parts.push('<\/script>');

  parts.push('</body>');
  parts.push('</html>');

  return parts.join('\n');
}

// ─── Static Assets ────────────────────────────────────────────────────

const BOOK_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
  '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/>' +
  '<path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>' +
  '</svg>';

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#ffffff;--sidebar-bg:#f8f9fb;--border:#e5e7eb;
  --text:#1e293b;--text-muted:#64748b;--primary:#2563eb;
  --primary-soft:#eff6ff;--hover:#f1f5f9;--code-bg:#f1f5f9;
  --radius:8px;--shadow:0 1px 3px rgba(0,0,0,.08);
}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  line-height:1.65;color:var(--text);background:var(--bg)}

.layout{display:flex;min-height:100vh}
.sidebar{width:280px;background:var(--sidebar-bg);border-right:1px solid var(--border);
  position:fixed;top:0;left:0;bottom:0;overflow-y:auto;padding:24px 16px;
  display:flex;flex-direction:column;z-index:10}
.content{margin-left:280px;flex:1;padding:48px 64px;max-width:960px}

.sidebar-header{margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.sidebar-title{font-size:16px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px}
.sidebar-title svg{flex-shrink:0}
.sidebar-meta{font-size:11px;color:var(--text-muted);margin-top:6px}
.nav-section{margin-bottom:2px}
.nav-item{display:block;padding:7px 12px;border-radius:var(--radius);cursor:pointer;
  font-size:13px;color:var(--text);text-decoration:none;transition:all .15s;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav-item:hover{background:var(--hover)}
.nav-item.active{background:var(--primary-soft);color:var(--primary);font-weight:600}
.nav-item.overview{font-weight:600;margin-bottom:4px}
.nav-children{padding-left:14px;border-left:1px solid var(--border);margin-left:12px}
.nav-group-label{font-size:11px;font-weight:600;color:var(--text-muted);
  text-transform:uppercase;letter-spacing:.5px;padding:12px 12px 4px;user-select:none}
.sidebar-footer{margin-top:auto;padding-top:16px;border-top:1px solid var(--border);
  font-size:11px;color:var(--text-muted);text-align:center}

.content h1{font-size:28px;font-weight:700;margin-bottom:8px;line-height:1.3}
.content h2{font-size:22px;font-weight:600;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.content h3{font-size:17px;font-weight:600;margin:24px 0 8px}
.content h4{font-size:15px;font-weight:600;margin:20px 0 6px}
.content p{margin:12px 0}
.content ul,.content ol{margin:12px 0 12px 24px}
.content li{margin:4px 0}
.content a{color:var(--primary);text-decoration:none}
.content a:hover{text-decoration:underline}
.content blockquote{border-left:3px solid var(--primary);padding:8px 16px;margin:16px 0;
  background:var(--primary-soft);border-radius:0 var(--radius) var(--radius) 0;
  color:var(--text-muted);font-size:14px}
.content code{font-family:'SF Mono',Consolas,'Courier New',monospace;font-size:13px;
  background:var(--code-bg);padding:2px 6px;border-radius:4px}
.content pre{background:#1e293b;color:#e2e8f0;border-radius:var(--radius);padding:16px;
  overflow-x:auto;margin:16px 0}
.content pre code{background:none;padding:0;font-size:13px;line-height:1.6;color:inherit}
.content table{border-collapse:collapse;width:100%;margin:16px 0}
.content th,.content td{border:1px solid var(--border);padding:8px 12px;text-align:left;font-size:14px}
.content th{background:var(--sidebar-bg);font-weight:600}
.content img{max-width:100%;border-radius:var(--radius)}
.content hr{border:none;border-top:1px solid var(--border);margin:32px 0}
.content .mermaid{margin:20px 0;text-align:center}

.menu-toggle{display:none;position:fixed;top:12px;left:12px;z-index:20;
  background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);
  padding:8px 12px;cursor:pointer;font-size:18px;box-shadow:var(--shadow)}
@media(max-width:768px){
  .sidebar{transform:translateX(-100%);transition:transform .2s}
  .sidebar.open{transform:translateX(0);box-shadow:2px 0 12px rgba(0,0,0,.1)}
  .content{margin-left:0;padding:24px 20px;padding-top:56px}
  .menu-toggle{display:block}
}
.empty-state{text-align:center;padding:80px 20px;color:var(--text-muted)}
.empty-state h2{font-size:20px;margin-bottom:8px;border:none}
`;

// The client-side JS is kept as a plain string to avoid template literal conflicts
const JS_APP = `
(function() {
  var activePage = 'overview';
  var navigationVersion = 0;
  var mermaidQueue = Promise.resolve();

  document.addEventListener('DOMContentLoaded', function() {
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
    renderMeta();
    renderNav();
    document.getElementById('menu-toggle').addEventListener('click', function() {
      document.getElementById('sidebar').classList.toggle('open');
    });
    if (location.hash && location.hash.length > 1) {
      try { activePage = decodeURIComponent(location.hash.slice(1)); } catch(e) { activePage = 'overview'; }
    }
    navigateTo(activePage);
  });

  function renderMeta() {
    if (!META) return;
    var el = document.getElementById('meta-info');
    var parts = [];
    if (META.generatedAt) {
      parts.push(new Date(META.generatedAt).toLocaleDateString());
    }
    if (META.model) parts.push(META.model);
    if (META.fromCommit) parts.push(META.fromCommit.slice(0, 8));
    el.textContent = parts.join(' \\u00b7 ');
  }

  function renderNav() {
    var container = document.getElementById('nav-tree');
    var html = '<div class="nav-section">';
    html += '<a class="nav-item overview" data-page="overview" href="#overview">' + escH(MESSAGES.overview) + '</a>';
    html += '</div>';
    if (TREE.length > 0) {
      html += '<div class="nav-group-label">' + escH(MESSAGES.modules) + '</div>';
      html += buildNavTree(TREE);
    }
    container.innerHTML = html;
    container.addEventListener('click', function(e) {
      var target = e.target;
      while (target && !target.dataset.page) { target = target.parentElement; }
      if (target && target.dataset.page) {
        e.preventDefault();
        navigateTo(target.dataset.page);
      }
    });
  }

  function buildNavTree(nodes) {
    var html = '';
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      html += '<div class="nav-section">';
      html += '<a class="nav-item" data-page="' + escH(node.slug) + '" href="#' + encodeURIComponent(node.slug) + '">' + escH(node.name) + '</a>';
      if (node.children && node.children.length > 0) {
        html += '<div class="nav-children">' + buildNavTree(node.children) + '</div>';
      }
      html += '</div>';
    }
    return html;
  }

  function escH(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function navigateTo(page) {
    var currentNavigation = ++navigationVersion;
    activePage = page;
    location.hash = encodeURIComponent(page);

    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].dataset.page === page) {
        items[i].classList.add('active');
      } else {
        items[i].classList.remove('active');
      }
    }

    var contentEl = document.getElementById('content');
    var md = PAGES[page];

    if (!md) {
      contentEl.replaceChildren();
      var empty = document.createElement('div');
      empty.className = 'empty-state';
      var heading = document.createElement('h2');
      heading.textContent = MESSAGES.pageNotFound;
      var detail = document.createElement('p');
      detail.textContent = page + '.md';
      empty.appendChild(heading);
      empty.appendChild(detail);
      contentEl.appendChild(empty);
      return;
    }

    var template = document.createElement('template');
    template.innerHTML = marked.parse(md);
    sanitizeRenderedContent(template.content);
    contentEl.replaceChildren(template.content.cloneNode(true));

    // Rewrite .md links to hash navigation
    var links = contentEl.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      if (href && href.endsWith('.md') && href.indexOf('://') === -1) {
        var slug = href.replace(/\\.md$/, '');
        links[i].setAttribute('href', '#' + encodeURIComponent(slug));
        (function(s) {
          links[i].addEventListener('click', function(e) {
            e.preventDefault();
            navigateTo(s);
          });
        })(slug);
      } else if (href && /^https:\\/\\//i.test(href)) {
        links[i].setAttribute('rel', 'noopener noreferrer');
      }
    }

    // Convert mermaid code blocks into mermaid divs
    var mermaidBlocks = contentEl.querySelectorAll('pre code.language-mermaid');
    for (var i = 0; i < mermaidBlocks.length; i++) {
      var pre = mermaidBlocks[i].parentElement;
      var div = document.createElement('div');
      div.className = 'mermaid';
      div.textContent = mermaidBlocks[i].textContent;
      pre.parentNode.replaceChild(div, pre);
    }
    mermaidQueue = mermaidQueue.then(function() {
      if (currentNavigation !== navigationVersion) return;
      return renderMermaidBlocks(contentEl);
    });

    window.scrollTo(0, 0);
    document.getElementById('sidebar').classList.remove('open');
  }

  async function renderMermaidBlocks(root) {
    var blocks = Array.from(root.querySelectorAll('.mermaid'));
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var source = block.textContent || '';
      try {
        await mermaid.run({ nodes: [block], suppressErrors: true });
        if (block.textContent.indexOf('Syntax error in text') !== -1) {
          throw new Error('Mermaid syntax error');
        }
      } catch(e) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('GitNexus Wiki Mermaid fallback:', e);
        }
        var pre = document.createElement('pre');
        var code = document.createElement('code');
        code.className = 'language-mermaid mermaid-error-source';
        code.textContent = source;
        pre.appendChild(code);
        block.replaceWith(pre);
      }
    }
  }

  function sanitizeRenderedContent(root) {
    var blocked = root.querySelectorAll('script,iframe,object,embed,style,link,meta,base,form,input,button,textarea,select,option,video,audio,source');
    for (var i = 0; i < blocked.length; i++) blocked[i].remove();

    var elements = root.querySelectorAll('*');
    for (var i = 0; i < elements.length; i++) {
      var attrs = Array.from(elements[i].attributes);
      for (var j = 0; j < attrs.length; j++) {
        var name = attrs[j].name.toLowerCase();
        var value = attrs[j].value;
        if (name.indexOf('on') === 0 || name === 'srcdoc' || name === 'style') {
          elements[i].removeAttribute(attrs[j].name);
        } else if ((name === 'href' || name === 'src' || name === 'xlink:href') && !isSafeUrl(value, name)) {
          elements[i].removeAttribute(attrs[j].name);
        }
      }
    }
  }

  function isSafeUrl(value, attribute) {
    var compact = String(value || '').replace(/[\\u0000-\\u0020\\u007f]+/g, '');
    var decoded = compact;
    try { decoded = decodeURIComponent(compact); } catch(e) {}
    var lower = decoded.toLowerCase();
    if (lower.indexOf('javascript:') === 0 || lower.indexOf('vbscript:') === 0 || lower.indexOf('file:') === 0) return false;
    if (lower.indexOf('data:') === 0) {
      return attribute === 'src' && /^data:image\\/(png|gif|jpeg|webp);base64,/i.test(lower);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(lower)) {
      return attribute === 'href'
        ? /^(https?:|mailto:)/i.test(lower)
        : /^https:/i.test(lower);
    }
    return true;
  }
})();
`;
