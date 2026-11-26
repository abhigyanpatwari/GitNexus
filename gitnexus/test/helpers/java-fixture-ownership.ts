import Parser from 'tree-sitter';
import { afterAll } from 'vitest';

// Observe the real parser. A helper can construct a Java project in memory or
// parse while a suite is being collected, before any test callback runs.
const original = Parser.prototype.parse;
let firstJavaParse: Error | undefined;
Parser.prototype.parse = function (this: Parser, ...args: Parameters<Parser['parse']>) {
  if (!firstJavaParse && this.getLanguage()?.name === 'java') {
    firstJavaParse = new Error('Move this Java source fixture to npm run test:conformance:java.');
  }
  return original.apply(this, args);
};

afterAll(() => {
  Parser.prototype.parse = original;
  if (firstJavaParse) throw firstJavaParse;
});
