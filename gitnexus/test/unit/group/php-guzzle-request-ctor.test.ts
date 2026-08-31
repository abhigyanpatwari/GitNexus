import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { PHP_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/php.js';

const parser = new Parser();
parser.setLanguage(PHP.php_only);

const scan = (src: string) => PHP_HTTP_PLUGIN.scan(parser.parse(src));
const consumers = (src: string) => scan(src).filter((d) => d.role === 'consumer');

describe('PHP guzzle-request-ctor pattern', () => {
  it('resolves a locally-assigned $resourcePath concatenated with a member-access host, method is a real parameter', () => {
    // $method is a FUNCTION PARAMETER here (the shape openapi-generator-php
    // actually emits — the verb is fixed by the caller of this builder
    // method, not assigned inside its body), not a local variable that
    // happens to share the resolver's single-scope shape. A local
    // `$method = 'POST';` immediately before the call would in fact resolve
    // via the same fold as `$resourcePath` — that's a different case,
    // covered separately below.
    const src = `<?php
class PaymentsApi {
    public function pay($method, $order) {
        $resourcePath = '/payments/pay';
        $request = new Request(
            $method,
            $this->operationHost . $resourcePath
        );
        return $this->client->send($request);
    }
}
`;
    const found = consumers(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      framework: 'guzzle-request-ctor',
      method: '*', // $method is a parameter, not a literal at this call site
      path: '/payments/pay',
    });
  });

  it('resolves a fully-qualified GuzzleHttp/Psr7/Request with a literal verb', () => {
    // Built via join(), not a literal backslash in this source file: a
    // template-literal backslash-escape is easy to mis-transcribe (dropped
    // silently by the JS/TS escape rules for an unrecognized `\<char>`), so
    // this sidesteps that entirely and is robust regardless of how the file
    // itself gets written to disk.
    const bs = String.fromCharCode(92);
    const qualified = ['', 'GuzzleHttp', 'Psr7', 'Request'].join(bs);
    const src = [
      '<?php',
      'function callIt($host) {',
      "    $resourcePath = '/payments/getPaymentStatus';",
      `    $request = new ${qualified}('GET', $host . $resourcePath);`,
      '    return $request;',
      '}',
      '',
    ].join('\n');
    const found = consumers(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      framework: 'guzzle-request-ctor',
      method: 'GET',
      path: '/payments/getPaymentStatus',
    });
  });

  it('accepts a fully literal call with no variable to resolve', () => {
    const src = `<?php
$request = new Request('GET', '/health');
`;
    const found = consumers(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ method: 'GET', path: '/health' });
  });

  it('does not resolve a variable assigned in a DIFFERENT function scope', () => {
    const src = `<?php
function setup() {
    $resourcePath = '/payments/pay';
}
function pay($method) {
    $request = new Request($method, $this->host . $resourcePath);
    return $request;
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('ignores an unrelated constructor whose class name does not end in "Request"', () => {
    // $resourcePath IS resolvable here (unlike an earlier version of this
    // test) — the class-name filter must be the reason this produces no
    // detection, not an incidental miss elsewhere in the pipeline. Without
    // a resolvable path, this test would pass even with the class-name
    // filter deleted.
    const src = `<?php
function make($method) {
    $resourcePath = '/payments/pay';
    $response = new Response($method, $this->host . $resourcePath);
    return $response;
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('rejects a resolved literal that is not an HTTP-looking path', () => {
    const src = `<?php
function pay($method) {
    $resourcePath = 'not-a-path';
    $request = new Request($method, $this->host . $resourcePath);
    return $request;
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('prefers the LAST variable in a 3-part concatenation (path, not an earlier segment)', () => {
    const src = `<?php
function pay($method) {
    $base = '/not/the/path';
    $resourcePath = '/payments/pay';
    $request = new Request($method, $base . $resourcePath);
    return $request;
}
`;
    const found = consumers(src);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('/payments/pay');
  });

  it('looks INSIDE a parenthesized right operand instead of falling back to the left one', () => {
    // Regression: an earlier version of lastConcatVariable treated an
    // unhandled `parenthesized_expression` as "no variable here" and fell
    // through to the LEFT operand — silently returning $host instead of
    // failing to find anything inside the parens.
    const src = `<?php
function pay($method) {
    $host = 'https://api.example.com';
    $resourcePath = '/payments/pay';
    $suffix = '?x=1';
    $request = new Request($method, $host . ($resourcePath . $suffix));
    return $request;
}
`;
    // $suffix (the real last variable) resolves to a non-path literal, so
    // this must find NOTHING — never mistake $host for the path.
    expect(consumers(src)).toHaveLength(0);
  });

  it('resolves an assignment made in an ENCLOSING block within the same function (if/try nesting)', () => {
    // Regression: resolveLocalStringLiteral stopped at the nearest
    // compound_statement (the `if` block), not the enclosing function body,
    // so an assignment made just above the `if` — in the same function —
    // was invisible to a `new Request(...)` call nested inside it.
    const src = `<?php
function pay($method, $order) {
    $resourcePath = '/payments/pay';
    if ($order->isValid()) {
        $request = new Request($method, $this->host . $resourcePath);
        return $request;
    }
    return null;
}
`;
    const found = consumers(src);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('/payments/pay');
  });

  it('still does not cross into a sibling function even when searching level by level', () => {
    // The level-by-level widening must stop at `program` / the enclosing
    // function boundary — it must not walk into a DIFFERENT function's body
    // just because that function is a preceding sibling statement.
    const src = `<?php
function setup() {
    if (true) {
        $resourcePath = '/payments/pay';
    }
}
function pay($method) {
    if (true) {
        $request = new Request($method, $this->host . $resourcePath);
        return $request;
    }
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('does not resolve through an intervening non-literal reassignment (last write wins)', () => {
    // Regression: the backward scan used to skip PAST an assignment whose
    // RHS wasn't a string literal, landing on an older literal that the
    // variable no longer holds at the call site — a wrong answer, not a
    // miss. The nearest assignment must decide the outcome, full stop.
    const src = `<?php
function pay($method) {
    $resourcePath = '/old-and-wrong';
    $resourcePath = buildPath();
    $request = new Request($method, $this->host . $resourcePath);
    return $request;
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('does not treat a non-concatenation binary expression as a path candidate', () => {
    // Regression: lastConcatVariable recursed into ANY binary_expression
    // without checking the operator, so `$host ?? $resourcePath` (or `&&`,
    // `+`, ...) was walked exactly like `.` concatenation.
    const src = `<?php
function pay($method) {
    $resourcePath = '/payments/pay';
    $request = new Request($method, $this->host ?? $resourcePath);
    return $request;
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('matches a lowercase "request" constructor — PHP class names are case-insensitive', () => {
    const src = `<?php
$request = new request('GET', '/health');
`;
    const found = consumers(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ method: 'GET', path: '/health' });
  });

  it('resolves $method via the same local fold as $resourcePath when it is a local variable, not a parameter', () => {
    const src = `<?php
function pay($order) {
    $resourcePath = '/payments/pay';
    $method = 'POST';
    $request = new Request($method, $this->host . $resourcePath);
    return $request;
}
`;
    const found = consumers(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ method: 'POST', path: '/payments/pay' });
  });

  it('does not use a stale literal shadowed by a reassignment inside a preceding if block', () => {
    // Regression: the backward scan only inspected direct expression_statement
    // siblings, so `$resourcePath = '/new';` nested inside an `if` right
    // before the call was invisible, and the OLDER `/old` (outside the `if`)
    // was returned instead — an unconditional wrong answer whenever that
    // branch runs, not a miss.
    const src = `<?php
function pay($method, $cond) {
    $resourcePath = '/old-and-wrong';
    if ($cond) {
        $resourcePath = '/new';
    }
    $request = new Request($method, $this->host . $resourcePath);
    return $request;
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('does not resolve a variable across an anonymous-function boundary it was not use()-captured into', () => {
    // Regression: level-by-level widening climbed straight from the
    // closure's body to the enclosing method's body without checking PHP's
    // actual capture rule (closures capture NOTHING unless listed in
    // `use (...)`), resolving a variable the closure can't actually see —
    // real PHP would throw "Undefined variable" here, not build this path.
    const src = `<?php
function pay($method) {
    $resourcePath = '/payments/pay';
    $build = function () use ($method) {
        // $resourcePath is NOT captured — undefined inside this closure.
        return new Request($method, $this->host . $resourcePath);
    };
    return $build();
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('DOES resolve a variable across an anonymous-function boundary it WAS use()-captured into', () => {
    const src = `<?php
function pay($method) {
    $resourcePath = '/payments/pay';
    $build = function () use ($method, $resourcePath) {
        return new Request($method, $this->host . $resourcePath);
    };
    return $build();
}
`;
    const found = consumers(src);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('/payments/pay');
  });

  it('does not fall back to the host when the concatenation ends in a string literal, not a variable', () => {
    // Regression: lastConcatVariable fell through to the LEFT operand when
    // the right one wasn't a variable, so `$host . '/users'` resolved to
    // $host instead of recognizing the trailing literal isn't a variable at
    // all — if $host happened to be an HTTP URL locally, that URL would be
    // emitted as the path instead of a miss.
    const src = `<?php
function pay($method) {
    $host = 'https://api.example.com';
    $request = new Request($method, $host . '/users');
    return $request;
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('does not resolve a variable from file/script scope into a class method (no implicit global in PHP)', () => {
    // Regression: after exhausting a method's own body, widening went
    // straight to `program` (file scope) and found the top-level literal —
    // but PHP methods have NO access to file-level variables without an
    // explicit `global $v;`, which this resolver deliberately never adds
    // support for. This produced a wrong contract, not a miss.
    const src = `<?php
$resourcePath = '/global-and-wrong';

class PaymentsApi {
    public function pay($method) {
        $request = new Request($method, $this->host . $resourcePath);
        return $request;
    }
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('does not resolve a variable from file scope into a plain top-level function either', () => {
    const src = `<?php
$resourcePath = '/global-and-wrong';

function pay($method) {
    $request = new Request($method, $GLOBALS['host'] . $resourcePath);
    return $request;
}
`;
    expect(consumers(src)).toHaveLength(0);
  });

  it('DOES resolve when the call site is itself at file/script scope (no function boundary to cross)', () => {
    const src = `<?php
$resourcePath = '/payments/pay';
$request = new Request('GET', $host . $resourcePath);
`;
    const found = consumers(src);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('/payments/pay');
  });
});
