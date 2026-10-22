import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('PHP qualified factory review boundaries', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'php-factory-review-'));
    const sources = {
      'same-name.php':
        '<?php namespace Ns; class Product { function ping() {} } function make(): Product { return new Product(); } class make { function ping() {} }',
      'caller.php':
        '<?php function callResult() { $x = Ns\\make(); $x->ping(); } function inlineCallResult() { Ns\\make()->ping(); }',
      'absolute.php': '<?php function absoluteResult() { $x = \\Ns\\make(); $x->ping(); }',
      'relative.php':
        '<?php namespace Ns; function relativeResult() { $x = namespace\\make(); $x->ping(); } function bareClosureResult() { $f = make(...); $f->ping(); }',
      'duplicate-one.php':
        '<?php namespace Dup; class Product { function ping() {} } function make(): Product { return new Product(); }',
      'duplicate-two.php': '<?php namespace Dup { function make() {} } namespace Other {}',
      'duplicate-caller.php': '<?php function duplicateResult() { $x = Dup\\make(); $x->ping(); }',
      'semicolon-one.php':
        '<?php namespace Semi; class Product { function ping() {} } function make(): Product { return new Product(); }',
      'semicolon-two.php':
        '<?php namespace OtherSemi; function unrelated() {} namespace Semi; function make() {}',
      'semicolon-caller.php':
        '<?php function semicolonDuplicateResult() { $x = Semi\\make(); $x->ping(); }',
      'long-one.php':
        '<?php namespace LongDup; class Product { function ping() {} } function make(): Product { return new Product(); }',
      'long-two.php':
        '<?php namespace LongDup { function make() {} } /*' +
        'x'.repeat(40000) +
        '*/ namespace OtherLong {}',
      'long-caller.php':
        '<?php function longDuplicateResult() { $x = LongDup\\make(); $x->ping(); }',
      'first-class.php':
        '<?php namespace Caller; use Ns as rp; class LocalProduct { function ping() {} } function localMake(): LocalProduct { return new LocalProduct(); } function closureResult() { $f = rp\\make(...); $f->ping(); } function relativeClosureResult() { $f = namespace\\localMake(...); $f->ping(); }',
      'positive.php':
        '<?php namespace Plain; class Expected { function ping() {} } function make(): Expected { return new Expected(); }',
      'positive-caller.php': '<?php function positiveResult() { $x = Plain\\make(); $x->ping(); }',
      'scoped-producer.php':
        '<?php namespace Producer; class Product { function ping() {} } function make(): Product { return new Product(); }',
      'scoped-caller.php':
        '<?php namespace Consumer; class Product { function ping() {} } function producerOwner() { $x = \\Producer\\make(); $x->ping(); } function inlineProducerOwner() { \\Producer\\make()->ping(); }',
      'member-first-class.php':
        '<?php class Result { function ping() {} } class Service { function make(): Result { return new Result(); } static function build(): Result { return new Result(); } } function memberClosure() { $s = new Service(); $f = $s->make(...); $f->ping(); } function staticClosure() { $f = Service::build(...); $f->ping(); }',
      'multi-producer.php':
        '<?php namespace Wrong; class AmbiguousProduct { function ping() {} } namespace Real; class AmbiguousProduct { function ping() {} } function make(): AmbiguousProduct { return new AmbiguousProduct(); }',
      'multi-producer-caller.php':
        '<?php function unsafeProducer() { $x = \\Real\\make(); $x->ping(); } function unsafeInlineProducer() { \\Real\\make()->ping(); }',
      'inline-first-class.php': '<?php function inlineClosureResult() { \\Ns\\make(...)->ping(); }',
      'commented-inline-first-class.php':
        '<?php function commentedInlineClosureResult() { \\Ns\\make(/* before */ ... /* after */)->ping(); }',
      'commented-header.php':
        '<?php /* α */ /* second */ namespace Commented; class HeaderProduct { function ping() {} } function make(): HeaderProduct { return new HeaderProduct(); }',
      'commented-header-caller.php':
        '<?php function commentedHeaderResult() { $x = \\Commented\\make(); $x->ping(); }',
      'function-alias-caller.php':
        '<?php namespace AliasCaller; use function Plain\\make as createExpected; function functionAliasResult() { $x = createExpected(); $x->ping(); }',
      'unowned-function-alias.php':
        '<?php namespace UnsafeAlias; use function Real\\make as createAmbiguous; function unsafeAliasedProducer() { $x = createAmbiguous(); $x->ping(); }',
      'annotation-factory.php':
        '<?php namespace TypeLib; class AnnotationProduct { function ping() {} } function ExternalType(): AnnotationProduct { return new AnnotationProduct(); }',
      'annotation-caller.php':
        '<?php function externalParameter(\\TypeLib\\ExternalType $value) { $value->ping(); } class ConsumerField { public \\TypeLib\\ExternalType $value; public function externalField() { $this->value->ping(); } }',
      'unicode-namespace.php':
        '<?php namespace café; class NamespaceProduct { function ping() {} } function make(): NamespaceProduct { return new NamespaceProduct(); }',
      'unicode-function.php':
        '<?php namespace UnicodeFactory; class FunctionProduct { function ping() {} } function fabriqué(): FunctionProduct { return new FunctionProduct(); }',
      'unicode-symbols.php':
        '<?php namespace £; class SymbolProduct { function ping() {} } function ¥(): SymbolProduct { return new SymbolProduct(); }',
      'unicode-combining.php':
        '<?php namespace e\u0301; class CombiningProduct { function ping() {} } function cre\u0301er(): CombiningProduct { return new CombiningProduct(); }',
      'unicode-caller.php':
        '<?php function unicodeNamespace() { $x = café\\make(); $x->ping(); } function unicodeFunction() { $x = \\UnicodeFactory\\fabriqué(); $x->ping(); } function unicodeSymbols() { $x = \\£\\¥(); $x->ping(); } function unicodeCombining() { $x = \\e\u0301\\cre\u0301er(); $x->ping(); }',
      'unicode-decoy.php':
        '<?php class WrongUnicodeProduct { function ping() {} } function make(): WrongUnicodeProduct { return new WrongUnicodeProduct(); } function fabriqué(): WrongUnicodeProduct { return new WrongUnicodeProduct(); } function ¥(): WrongUnicodeProduct { return new WrongUnicodeProduct(); } function cre\u0301er(): WrongUnicodeProduct { return new WrongUnicodeProduct(); }',
      'unicode-distinct.php':
        '<?php namespace DistinctUnicode; class LowerProduct { function ping() {} } class UpperProduct { function ping() {} } function café(): LowerProduct { return new LowerProduct(); } function cafÉ(): UpperProduct { return new UpperProduct(); }',
      'unicode-case-caller.php':
        '<?php function asciiNamespaceCase() { $x = \\CAFé\\MAKE(); $x->ping(); } function asciiFunctionCase() { $x = \\UNICODEFACTORY\\FABRIQUé(); $x->ping(); } function wrongUnicodeNamespaceCase() { $x = \\cafÉ\\make(); $x->ping(); } function wrongUnicodeFunctionCase() { $x = \\UnicodeFactory\\fabriquÉ(); $x->ping(); } function distinctLower() { $x = \\DistinctUnicode\\café(); $x->ping(); } function distinctUpper() { $x = \\DistinctUnicode\\cafÉ(); $x->ping(); }',
      'unicode-alias-caller.php':
        '<?php namespace UnicodeAliases; use UnicodeFactory as café; function exactUnicodeAlias() { $x = café\\fabriqué(); $x->ping(); } function asciiUnicodeAlias() { $x = CAFé\\FABRIQUé(); $x->ping(); } function wrongUnicodeAliasCase() { $x = cafÉ\\fabriqué(); $x->ping(); }',
      'unicode-keyword.php':
        '<?php namespace UnicodeKeyword; class KeywordProduct { function ping() {} } function make(): KeywordProduct { return new KeywordProduct(); } function asciiKeywordCase() { $x = NAMESPACE\\make(); $x->ping(); } function wrongUnicodeKeyword() { $x = name\u017Fpace\\make(); $x->ping(); }',
      'unicode-nbsp-caller.php':
        '<?php function wrongTrailingNbsp() { $x = \\UnicodeKeyword\\make\u00A0(); $x->ping(); } function wrongCommentedNbsp() { $x = \\UnicodeKeyword\\make\u00A0/* gap */(); $x->ping(); } function unicodeGapComment() { $x = \\UnicodeFactory\\fabriqué /* \u00A0é */ (); $x->ping(); }',
    };
    for (const [file, source] of Object.entries(sources))
      await fs.writeFile(path.join(root, file), source);
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  const calls = (caller: string, callee?: string) =>
    [...result.graph.iterRelationships()].filter(
      (edge) =>
        edge.type === 'CALLS' &&
        result.graph.getNode(edge.sourceId)?.properties.name === caller &&
        (callee === undefined || result.graph.getNode(edge.targetId)?.properties.name === callee),
    );
  const owner = (method: string) =>
    [...result.graph.iterRelationships()].find(
      (edge) => edge.type === 'HAS_METHOD' && edge.targetId === method,
    )?.sourceId;
  it.each([
    ['unicodeNamespace', 'unicode-namespace.php', 'NamespaceProduct', 'make'],
    ['unicodeFunction', 'unicode-function.php', 'FunctionProduct', 'fabriqué'],
    ['unicodeSymbols', 'unicode-symbols.php', 'SymbolProduct', '¥'],
    ['unicodeCombining', 'unicode-combining.php', 'CombiningProduct', 'cre\u0301er'],
    ['asciiNamespaceCase', 'unicode-namespace.php', 'NamespaceProduct', 'make'],
    ['asciiFunctionCase', 'unicode-function.php', 'FunctionProduct', 'fabriqué'],
    ['distinctLower', 'unicode-distinct.php', 'LowerProduct', 'café'],
    ['distinctUpper', 'unicode-distinct.php', 'UpperProduct', 'cafÉ'],
    ['exactUnicodeAlias', 'unicode-function.php', 'FunctionProduct', 'fabriqué'],
    ['asciiUnicodeAlias', 'unicode-function.php', 'FunctionProduct', 'fabriqué'],
    ['asciiKeywordCase', 'unicode-keyword.php', 'KeywordProduct', 'make'],
    ['unicodeGapComment', 'unicode-function.php', 'FunctionProduct', 'fabriqué'],
  ])('types %s from the exact qualified Unicode producer', (caller, file, product, factory) => {
    expect(calls(caller, 'ping').map((edge) => edge.targetId)).toEqual([
      `Method:${file}:${product}.ping#0`,
    ]);
    expect(calls(caller, factory).map((edge) => edge.targetId)).toEqual([
      `Function:${file}:${factory}`,
    ]);
  });
  it.each([
    'wrongUnicodeNamespaceCase',
    'wrongUnicodeFunctionCase',
    'wrongUnicodeAliasCase',
    'wrongUnicodeKeyword',
    'wrongTrailingNbsp',
    'wrongCommentedNbsp',
  ])('%s does not borrow a producer through non-ASCII case folding', (caller) => {
    expect(calls(caller)).toEqual([]);
  });
  it.each(['externalParameter', 'externalField'])(
    '%s never treats a qualified class annotation as a factory invocation',
    (caller) => {
      expect(calls(caller, 'ping')).toEqual([]);
    },
  );
  it.each(['unsafeProducer', 'unsafeInlineProducer', 'unsafeAliasedProducer'])(
    '%s refuses a producer with unowned return annotations',
    (caller) => {
      expect(calls(caller, 'ping')).toEqual([]);
      expect(calls(caller, 'make')).toEqual([]);
    },
  );
  it.each(['callResult', 'inlineCallResult', 'absoluteResult', 'relativeResult'])(
    'types %s from the function when a class shares its name',
    (caller) => {
      const targets = calls(caller, 'ping');
      expect(targets).toHaveLength(1);
      expect(result.graph.getNode(owner(targets[0]!.targetId)!)?.properties.name).toBe('Product');
    },
  );
  it.each(['duplicateResult', 'semicolonDuplicateResult', 'longDuplicateResult'])(
    'retains %s duplicate evidence from multi-namespace files',
    (caller) => {
      expect(calls(caller)).toEqual([]);
    },
  );
  it.each(['closureResult', 'relativeClosureResult', 'bareClosureResult'])(
    '%s does not invoke or inherit the factory return class',
    (caller) => {
      expect(calls(caller)).toEqual([]);
    },
  );
  it.each([
    'memberClosure',
    'staticClosure',
    'inlineClosureResult',
    'commentedInlineClosureResult',
  ])('%s does not type a Closure as its eventual return', (caller) => {
    expect(calls(caller, 'ping')).toEqual([]);
  });
  it.each(['producerOwner', 'inlineProducerOwner'])(
    '%s reads the return type in the producer scope',
    (caller) => {
      expect(calls(caller, 'ping').map((edge) => edge.targetId)).toEqual([
        'Method:scoped-producer.php:Product.ping#0',
      ]);
    },
  );
  it('retains the ordinary qualified factory result', () => {
    const targets = calls('positiveResult', 'ping');
    expect(targets).toHaveLength(1);
    expect(result.graph.getNode(owner(targets[0]!.targetId)!)?.properties.name).toBe('Expected');
  });
  it.each([
    ['commentedHeaderResult', 'HeaderProduct'],
    ['functionAliasResult', 'Expected'],
  ])('retains %s with producer namespace ownership', (caller, expected) => {
    const targets = calls(caller, 'ping');
    expect(targets).toHaveLength(1);
    expect(result.graph.getNode(owner(targets[0]!.targetId)!)?.properties.name).toBe(expected);
  });
});
