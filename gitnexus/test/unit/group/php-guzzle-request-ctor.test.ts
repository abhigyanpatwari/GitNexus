import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { PHP_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/php.js';

const parser = new Parser();
parser.setLanguage(PHP.php_only);

const scan = (src: string) => PHP_HTTP_PLUGIN.scan(parser.parse(src));
const consumers = (src: string) => scan(src).filter((d) => d.role === 'consumer');

describe('PHP guzzle-request-ctor pattern', () => {
  it('resolves a locally-assigned $resourcePath concatenated with a member-access host', () => {
    const src = `<?php
class PaymentsApi {
    public function pay($order) {
        $resourcePath = '/payments/pay';
        $method = 'POST';
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
      method: '*', // $method is itself a parameter — not a resolvable literal
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
    const src = `<?php
$response = new Response($this->host . $resourcePath);
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
});
