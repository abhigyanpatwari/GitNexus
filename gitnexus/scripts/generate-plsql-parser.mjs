#!/usr/bin/env node
/**
 * Regenerate the ANTLR4 PL/SQL lexer/parser under
 * src/core/ingestion/plsql/generated/ from the vendored grammars-v4 sources in
 * src/core/ingestion/plsql/grammar/.
 *
 *   npx --yes antlr-ng@1.0.10 is fetched on demand; it is not a runtime dependency.
 *
 * The grammar's C++ header placeholders are replaced with the antlr4ng base-class
 * imports, exactly as grammars-v4's `Antlr4ng/transformGrammar.py` does.
 */
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const grammarDir = path.join(root, 'src/core/ingestion/plsql/grammar');
const outDir = path.join(root, 'src/core/ingestion/plsql/generated');
const work = mkdtempSync(path.join(tmpdir(), 'plsql-grammar-'));

try {
  for (const name of ['PlSqlLexer.g4', 'PlSqlParser.g4']) {
    const text = readFileSync(path.join(grammarDir, name), 'utf8')
      .replace(
        '// Insert here @header for C++ lexer.',
        '@header {import { PlSqlLexerBase } from "./PlSqlLexerBase.js"}',
      )
      .replace(
        '// Insert here @header for C++ parser.',
        '@header {import { PlSqlParserBase } from "./PlSqlParserBase.js"}',
      );
    writeFileSync(path.join(work, name), text);
  }
  // String form runs through the platform shell (cmd.exe / sh) so `npx`
  // resolves to npx.cmd on Windows — execFileSync('npx') without a shell
  // fails there (same constraint as scripts/build-web.js).
  const quote = (arg) => `"${arg}"`;
  execSync(
    [
      'npx --yes antlr-ng@1.0.10 -Dlanguage=TypeScript -l true -v false',
      `-o ${quote(work)}`,
      quote(path.join(work, 'PlSqlLexer.g4')),
      quote(path.join(work, 'PlSqlParser.g4')),
    ].join(' '),
    { stdio: 'inherit' },
  );
  for (const file of readdirSync(work)) {
    if (/^PlSql(Lexer|Parser|ParserListener)\.ts$/.test(file))
      copyFileSync(path.join(work, file), path.join(outDir, file));
  }
  console.log(`[plsql] regenerated parser into ${path.relative(root, outDir)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
