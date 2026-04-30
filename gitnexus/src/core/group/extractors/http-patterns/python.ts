import Python from 'tree-sitter-python';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin, HttpScanContext } from './types.js';

/**
 * Python HTTP plugin. Handles:
 *   - FastAPI/APIRouter `@app.get("/path")` provider decorators
 *   - Flask `@app.route("/path", methods=[...])` provider decorators
 *   - Django `path()` / `re_path()` URLConf provider entries
 *   - `requests.get/post/...("url")` consumer calls
 *   - Generic `requests.request("METHOD", "url")` consumer calls
 *   - `httpx` / `aiohttp` client calls, including simple base_url joins
 */

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

// Provider: Blueprint/APIRouter prefix assignments.
const ROUTER_PREFIX_PATTERNS = compilePatterns({
  name: 'python-router-prefix',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (assignment
          left: (identifier) @name
          right: (call
            function: [
              (identifier) @factory
              (attribute attribute: (identifier) @factory)
            ]
            arguments: (argument_list
              (_)* 
              (keyword_argument
                name: (identifier) @prefix_key
                value: (string) @prefix)
              (_)*)))
        (#match? @factory "^(Blueprint|APIRouter)$")
        (#match? @prefix_key "^(url_prefix|prefix)$")
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Provider: FastAPI/APIRouter/Flask @app.get/post/... decorators.
const VERB_DECORATOR_PATTERNS = compilePatterns({
  name: 'python-verb-decorators',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (decorated_definition
          (decorator
            (call
              function: (attribute
                object: (identifier) @obj
                attribute: (identifier) @method (#match? @method "^(get|post|put|delete|patch|head|options)$"))
              arguments: (argument_list . (string) @path)) @call)
          definition: (function_definition
            name: (identifier) @name))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Provider: Flask @app.route(...) and FastAPI @app.api_route(...).
const ROUTE_DECORATOR_PATTERNS = compilePatterns({
  name: 'python-route-decorators',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (decorated_definition
          (decorator
            (call
              function: (attribute
                object: (identifier) @obj
                attribute: (identifier) @decorator (#match? @decorator "^(route|api_route)$"))
              arguments: (argument_list . (string) @path)) @call)
          definition: (function_definition
            name: (identifier) @name))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Provider: Django urls.py path()/re_path() URLConf entries.
const DJANGO_URLCONF_PATTERNS = compilePatterns({
  name: 'python-django-urlconf',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: (identifier) @func (#match? @func "^(path|re_path)$")
          arguments: (argument_list . (string) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Consumer: client variable assignments for httpx/aiohttp.
const PYTHON_CLIENT_ASSIGNMENT_PATTERNS = compilePatterns({
  name: 'python-client-assignments',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (assignment
          left: (identifier) @name
          right: (call
            function: (attribute
              object: (identifier) @module
              attribute: (identifier) @ctor)
            arguments: (argument_list)) @call)
        (#match? @module "^(httpx|aiohttp)$")
        (#match? @ctor "^(Client|AsyncClient|ClientSession)$")
      `,
    },
    {
      meta: {},
      query: `
        (as_pattern
          (call
            function: (attribute
              object: (identifier) @module
              attribute: (identifier) @ctor)
            arguments: (argument_list)) @call
          alias: (as_pattern_target (identifier) @name))
        (#match? @module "^(httpx|aiohttp)$")
        (#match? @ctor "^(Client|AsyncClient|ClientSession)$")
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Consumer: requests/httpx/aiohttp/client.get/post/...
const PYTHON_CLIENT_VERB_PATTERNS = compilePatterns({
  name: 'python-client-verb',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: (attribute
            object: (identifier) @obj
            attribute: (identifier) @method (#match? @method "^(get|post|put|delete|patch|head|options)$"))
          arguments: (argument_list . (string) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Consumer: requests/httpx/client.request("METHOD", "url").
const PYTHON_CLIENT_GENERIC_PATTERNS = compilePatterns({
  name: 'python-client-generic',
  language: Python,
  patterns: [
    {
      meta: {},
      query: `
        (call
          function: (attribute
            object: (identifier) @obj
            attribute: (identifier) @method (#eq? @method "request"))
          arguments: (argument_list . (string) @http_method (string) @path))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

interface PrefixInfo {
  framework: string;
  prefix: string;
}

interface ClientInfo {
  framework: string;
  baseUrl: string | null;
}

function methodFromIdentifier(name: string | undefined): string | null {
  const method = (name ?? '').toUpperCase();
  return HTTP_METHODS.has(method) ? method : null;
}

function unquotePythonLiteral(raw: string): string | null {
  const text = raw.trim();
  const direct = unquoteLiteral(text);
  if (direct === null) return null;
  if (direct !== text) return direct;

  const triple = text.match(/^[rRuUbBfF]{1,4}(['"]{3})([\s\S]*)\1$/);
  if (triple) return triple[2];

  const prefixed = text.match(/^[rRuUbBfF]{1,4}(['"])([\s\S]*)\1$/);
  if (prefixed) return prefixed[2];

  return direct;
}

function joinPath(prefix: string, sub: string): string {
  const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  const cleanSub = sub.replace(/^\/+/, '');
  if (!cleanPrefix) return `/${cleanSub}`.replace(/\/+$/, '') || '/';
  return `/${cleanPrefix}/${cleanSub}`.replace(/\/+$/, '') || '/';
}

function normalizePythonRoutePath(path: string): string {
  const withParams = path.replace(/<[^>]+>/g, '{param}');
  return joinPath('', withParams);
}

function normalizeDjangoRegexPath(path: string): string {
  let out = path.trim().replace(/^\^/, '').replace(/\$$/, '');
  out = out.replace(/\\\//g, '/');
  out = out.replace(/\(\?P<[^>]+>[^)]*\)/g, '{param}');
  out = out.replace(/\([^)]*\)/g, '{param}');
  out = out.replace(/\\d\+/g, '{param}');
  out = out.replace(/\[\^\/\]\+/g, '{param}');
  return joinPath('', out);
}

function methodsFromDecoratorCall(callText: string): string[] {
  const methodsKeyword = callText.match(/methods\s*=/);
  if (!methodsKeyword) return ['GET'];

  const container = callText.match(/methods\s*=\s*(\[[\s\S]*?\]|\([\s\S]*?\)|\{[\s\S]*?\})/);
  if (!container) return [];

  const out: string[] = [];
  const literalPattern = /['"]([A-Za-z]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = literalPattern.exec(container[1])) !== null) {
    const method = match[1].toUpperCase();
    if (HTTP_METHODS.has(method)) out.push(method);
  }
  return Array.from(new Set(out));
}

function extractKeywordString(callText: string, keyword: string): string | null {
  const literal = String.raw`([rRuUbBfF]{0,4}(?:"[^"]*"|'[^']*'))`;
  const match = callText.match(new RegExp(`${keyword}\\s*=\\s*${literal}`));
  if (!match) return null;
  return unquotePythonLiteral(match[1]);
}

function joinBaseUrl(baseUrl: string | null, requestPath: string): string {
  if (!baseUrl || /^https?:\/\//i.test(requestPath)) return requestPath;

  let basePath = baseUrl;
  if (/^https?:\/\//i.test(baseUrl)) {
    try {
      basePath = new URL(baseUrl).pathname || '/';
    } catch {
      basePath = baseUrl.replace(/^https?:\/\/[^/]+/i, '') || '/';
    }
  }

  return joinPath(basePath, requestPath);
}

function collectPrefixes(tree: Parameters<HttpLanguagePlugin['scan']>[0]): Map<string, PrefixInfo> {
  const prefixes = new Map<string, PrefixInfo>();
  for (const match of runCompiledPatterns(ROUTER_PREFIX_PATTERNS, tree)) {
    const nameNode = match.captures.name;
    const factoryNode = match.captures.factory;
    const prefixKeyNode = match.captures.prefix_key;
    const prefixNode = match.captures.prefix;
    if (!nameNode || !factoryNode || !prefixKeyNode || !prefixNode) continue;

    const prefix = unquotePythonLiteral(prefixNode.text);
    if (prefix === null) continue;

    if (factoryNode.text === 'Blueprint' && prefixKeyNode.text === 'url_prefix') {
      prefixes.set(nameNode.text, { framework: 'flask', prefix });
    }
    if (factoryNode.text === 'APIRouter' && prefixKeyNode.text === 'prefix') {
      prefixes.set(nameNode.text, { framework: 'fastapi', prefix });
    }
  }
  return prefixes;
}

function collectClients(tree: Parameters<HttpLanguagePlugin['scan']>[0]): Map<string, ClientInfo> {
  const clients = new Map<string, ClientInfo>();
  for (const match of runCompiledPatterns(PYTHON_CLIENT_ASSIGNMENT_PATTERNS, tree)) {
    const nameNode = match.captures.name;
    const moduleNode = match.captures.module;
    const callNode = match.captures.call;
    if (!nameNode || !moduleNode || !callNode) continue;

    clients.set(nameNode.text, {
      framework: moduleNode.text === 'aiohttp' ? 'python-aiohttp' : 'python-httpx',
      baseUrl: extractKeywordString(callNode.text, 'base_url'),
    });
  }
  return clients;
}

function clientInfoForObject(obj: string, clients: Map<string, ClientInfo>): ClientInfo | null {
  if (obj === 'requests') return { framework: 'python-requests', baseUrl: null };
  if (obj === 'httpx') return { framework: 'python-httpx', baseUrl: null };
  if (obj === 'aiohttp') return { framework: 'python-aiohttp', baseUrl: null };
  return clients.get(obj) ?? null;
}

export const PYTHON_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'python-http',
  language: Python,
  scan(tree, context?: HttpScanContext) {
    const out: HttpDetection[] = [];
    const prefixes = collectPrefixes(tree);
    const clients = collectClients(tree);

    // Providers: FastAPI/APIRouter/Flask @app.get/post/... decorators.
    for (const match of runCompiledPatterns(VERB_DECORATOR_PATTERNS, tree)) {
      const objNode = match.captures.obj;
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!objNode || !methodNode || !pathNode) continue;
      const httpMethod = methodFromIdentifier(methodNode.text);
      if (!httpMethod) continue;

      const path = unquotePythonLiteral(pathNode.text);
      if (path === null) continue;
      const prefixInfo = prefixes.get(objNode.text);

      out.push({
        role: 'provider',
        framework: prefixInfo?.framework ?? 'fastapi',
        method: httpMethod,
        path: normalizePythonRoutePath(joinPath(prefixInfo?.prefix ?? '', path)),
        name: match.captures.name?.text ?? null,
        confidence: 0.8,
      });
    }

    // Providers: Flask @app.route(...) and FastAPI @app.api_route(...).
    for (const match of runCompiledPatterns(ROUTE_DECORATOR_PATTERNS, tree)) {
      const objNode = match.captures.obj;
      const decoratorNode = match.captures.decorator;
      const callNode = match.captures.call;
      const pathNode = match.captures.path;
      if (!objNode || !decoratorNode || !callNode || !pathNode) continue;

      const path = unquotePythonLiteral(pathNode.text);
      if (path === null) continue;

      const prefixInfo = prefixes.get(objNode.text);
      const framework =
        decoratorNode.text === 'api_route' ? 'fastapi' : (prefixInfo?.framework ?? 'flask');
      const methods = methodsFromDecoratorCall(callNode.text);
      for (const method of methods) {
        out.push({
          role: 'provider',
          framework,
          method,
          path: normalizePythonRoutePath(joinPath(prefixInfo?.prefix ?? '', path)),
          name: match.captures.name?.text ?? null,
          confidence: 0.8,
        });
      }
    }

    // Providers: Django URLConf path()/re_path() entries. Restrict these
    // to urls.py-style files to avoid treating unrelated path() helpers as
    // HTTP routes.
    if ((context?.filePath ?? '').replace(/\\/g, '/').endsWith('urls.py')) {
      for (const match of runCompiledPatterns(DJANGO_URLCONF_PATTERNS, tree)) {
        const funcNode = match.captures.func;
        const pathNode = match.captures.path;
        if (!funcNode || !pathNode) continue;

        const rawPath = unquotePythonLiteral(pathNode.text);
        if (rawPath === null) continue;
        out.push({
          role: 'provider',
          framework: 'django',
          method: 'GET',
          path:
            funcNode.text === 're_path'
              ? normalizeDjangoRegexPath(rawPath)
              : normalizePythonRoutePath(rawPath),
          name: null,
          confidence: 0.65,
        });
      }
    }

    // Consumers: requests/httpx/aiohttp/client.<verb>
    for (const match of runCompiledPatterns(PYTHON_CLIENT_VERB_PATTERNS, tree)) {
      const objNode = match.captures.obj;
      const methodNode = match.captures.method;
      const pathNode = match.captures.path;
      if (!objNode || !methodNode || !pathNode) continue;

      const client = clientInfoForObject(objNode.text, clients);
      if (!client) continue;
      const path = unquotePythonLiteral(pathNode.text);
      if (path === null) continue;

      out.push({
        role: 'consumer',
        framework: client.framework,
        method: methodNode.text.toUpperCase(),
        path: joinBaseUrl(client.baseUrl, path),
        name: null,
        confidence: 0.7,
      });
    }

    // Consumers: requests/httpx/client.request("METHOD", "url").
    for (const match of runCompiledPatterns(PYTHON_CLIENT_GENERIC_PATTERNS, tree)) {
      const objNode = match.captures.obj;
      const methodNode = match.captures.http_method;
      const pathNode = match.captures.path;
      if (!objNode || !methodNode || !pathNode) continue;

      const client = clientInfoForObject(objNode.text, clients);
      if (!client) continue;
      const methodRaw = unquotePythonLiteral(methodNode.text);
      const path = unquotePythonLiteral(pathNode.text);
      if (methodRaw === null || path === null) continue;
      const method = methodRaw.toUpperCase();
      if (!HTTP_METHODS.has(method)) continue;

      out.push({
        role: 'consumer',
        framework: client.framework,
        method,
        path: joinBaseUrl(client.baseUrl, path),
        name: null,
        confidence: 0.7,
      });
    }

    return out;
  },
};
