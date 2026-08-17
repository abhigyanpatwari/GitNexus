import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import {
  getLanguageFromFilename,
  getSyntaxLanguageFromFilename,
  SupportedLanguages,
} from 'gitnexus-shared';
import { getLanguageForFileContent } from '../../src/core/ingestion/languages/index.js';
import { classifyObjectiveCFileContent } from '../../src/core/ingestion/languages/objective-c.js';
import {
  buildObjectiveCSemanticGraph,
  collectObjectiveCFacts,
  objcCategoryQualifiedName,
  objcClassQualifiedName,
  objcMethodQualifiedName,
} from '../../src/core/ingestion/languages/objective-c/facts.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';
import { objectiveCScopeResolver } from '../../src/core/ingestion/languages/objective-c/scope-resolver.js';

const FIXTURE = `#import "SYModuleCaller.h"
#include "SYModuleSupport.h"
@import Foundation;

@protocol SYModuleRunnable <NSObject>
- (void)runTask:(NSString *)name completion:(void (^)(BOOL ok))completion;
@end

@interface SYBaseCaller : NSObject
- (void)loadData:(NSString *)name completion:(void (^)(BOOL ok))completion;
@end

@interface SYModuleCaller : SYBaseCaller <SYModuleRunnable> {
  SYBaseCaller *_base;
}
@property (nonatomic, strong) SYBaseCaller *helper;
+ (instancetype)sharedCaller;
- (void)runTask:(NSString *)name completion:(void (^)(BOOL ok))completion;
@end

@interface SYModuleCaller ()
@property (nonatomic, strong) SYBaseCaller *privateHelper;
@end

@interface SYModuleCaller (Tracing)
- (void)traceEvent:(NSString *)name;
@end

@implementation SYModuleCaller
+ (instancetype)sharedCaller { return [SYModuleCaller new]; }
- (void)runTask:(NSString *)name completion:(void (^)(BOOL ok))completion {
  SYBaseCaller *typed = self.helper;
  id dynamic = typed;
  [self traceEvent:name];
  [super loadData:name completion:completion];
  [typed loadData:name completion:completion];
  [dynamic loadData:name completion:completion];
}
- (void)runProtocol:(id<SYModuleRunnable>)runner {
  [runner runTask:@"x" completion:^(BOOL ok) {}];
}
@end

@implementation SYModuleCaller (Tracing)
- (void)traceEvent:(NSString *)name {}
@end

static int SYModuleCompute(int value) { return value + 1; }
`;

function parseFixture() {
  const parser = new Parser();
  parser.setLanguage(requireVendoredGrammar('tree-sitter-objc'));
  return parser.parse(FIXTURE);
}

function parseSource(source: string) {
  const parser = new Parser();
  parser.setLanguage(requireVendoredGrammar('tree-sitter-objc'));
  return parser.parse(source);
}

describe('Objective-C provider', () => {
  it('loads the vendored grammar and maps unambiguous Objective-C extensions', () => {
    expect(isLanguageAvailable(SupportedLanguages.ObjectiveC)).toBe(true);
    expect(getLanguageFromFilename('SYModuleCaller.m')).toBe(SupportedLanguages.ObjectiveC);
    expect(getLanguageFromFilename('SYModuleCaller.mm')).toBe(SupportedLanguages.ObjectiveC);
    expect(getSyntaxLanguageFromFilename('SYModuleCaller.m')).toBe('objectivec');
  });

  it('classifies Objective-C headers by content without stealing plain C headers', () => {
    expect(
      classifyObjectiveCFileContent(
        'SYModuleCaller.h',
        '@interface SYModuleCaller : NSObject\n@end',
      ),
    ).toBe(true);
    expect(getLanguageForFileContent('SYModuleCaller.h', '@protocol SYModuleRunnable\n@end')).toBe(
      SupportedLanguages.ObjectiveC,
    );
    expect(
      getLanguageForFileContent('plain.h', '#ifndef PLAIN_H\nint add(int a, int b);\n#endif\n'),
    ).toBe(SupportedLanguages.CPlusPlus);
    expect(
      classifyObjectiveCFileContent('framework.h', '#import <Foundation/Foundation.h>\n'),
    ).toBe(true);
    expect(classifyObjectiveCFileContent('plain-cpp.h', 'class Widget { int value; };\n')).toBe(
      false,
    );
    expect(classifyObjectiveCFileContent('forward.h', '@class Widget;\n')).toBe(true);
  });

  it('extracts nested C function declarators without claiming function pointers', () => {
    const facts = collectObjectiveCFacts(
      parseSource(`
int add(int value);
int *returnsPointer(int value);
int (*callback)(int value);
`),
      'functions.h',
    );

    expect(facts.functions.map((fn) => fn.name)).toEqual(
      expect.arrayContaining(['add', 'returnsPointer']),
    );
    expect(facts.functions.map((fn) => fn.name)).not.toContain('callback');
  });

  it('does not treat protocol-qualified parameter types as conformance', () => {
    const facts = collectObjectiveCFacts(
      parseSource(`
@protocol P <NSObject>
- (void)run:(id<Q>)value;
@end
@interface Child : Base <P>
- (void)run:(id<Q>)value;
@end
`),
      'protocols.h',
    );

    expect(facts.containers.find((container) => container.name === 'P')?.protocols).toEqual([
      'NSObject',
    ]);
    expect(facts.containers.find((container) => container.name === 'Child')?.protocols).toEqual([
      'P',
    ]);
  });

  it('keeps explicit class receivers and macro receivers separate', () => {
    const facts = collectObjectiveCFacts(
      parseSource(`
#define RECEIVER_MACRO(x) x
@interface A
+ (void)run;
@end
@interface Base
- (void)ping;
@end
@interface Child : Base
- (void)call;
@end
@implementation Child
- (void)call {
  [A run];
  [self ping];
  [RECEIVER_MACRO(self) ping];
}
@end
`),
      'receivers.m',
    );

    expect(
      facts.messages.map((message) => `${message.receiverKind}:${message.receiverText}`),
    ).toEqual(expect.arrayContaining(['class:A', 'self:self', 'dynamic:RECEIVER_MACRO(self)']));
    expect(facts.unresolvedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          receiverText: 'RECEIVER_MACRO(self)',
          reason: 'macro receiver RECEIVER_MACRO is dynamic',
        }),
      ]),
    );
  });

  it('resolves extensionless local imports to Objective-C source/header files', () => {
    expect(
      objectiveCScopeResolver.resolveImportTarget(
        './NestedHeader',
        'src/Caller.m',
        new Set(['src/NestedHeader.h']),
      ),
    ).toBe('src/NestedHeader.h');
    expect(
      objectiveCScopeResolver.resolveImportTarget(
        './NestedImpl',
        'src/Caller.m',
        new Set(['src/NestedImpl.mm']),
      ),
    ).toBe('src/NestedImpl.mm');
    expect(
      objectiveCScopeResolver.resolveImportTarget(
        'Foundation',
        'src/Caller.m',
        new Set(['src/Foundation.h']),
      ),
    ).toBeNull();
  });

  it('extracts first-version Objective-C semantic facts and unresolved evidence', () => {
    const facts = collectObjectiveCFacts(parseFixture(), 'SYModuleCaller.m');

    expect(facts.containers.map((c) => `${c.kind}:${c.name}`)).toEqual(
      expect.arrayContaining([
        'protocol:SYModuleRunnable',
        'class:SYBaseCaller',
        'class:SYModuleCaller',
        'extension:SYModuleCaller ()',
        'category:SYModuleCaller (Tracing)',
      ]),
    );
    expect(
      facts.containers.find((c) => c.name === 'SYModuleCaller' && c.kind === 'class'),
    ).toMatchObject({
      superclass: 'SYBaseCaller',
      protocols: ['SYModuleRunnable'],
    });

    expect(
      facts.methods.map((m) => ({
        kind: m.methodKind,
        selector: m.selector,
        owner: m.ownerQualifiedName,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          kind: '-',
          selector: 'runTask:completion:',
          owner: objcClassQualifiedName('SYModuleCaller'),
        },
        {
          kind: '+',
          selector: 'sharedCaller',
          owner: objcClassQualifiedName('SYModuleCaller'),
        },
        {
          kind: '-',
          selector: 'traceEvent:',
          owner: objcCategoryQualifiedName('SYModuleCaller', 'Tracing'),
        },
        {
          kind: '-',
          selector: 'runTask:completion:',
          owner: 'objc:protocol:SYModuleRunnable',
        },
      ]),
    );
    expect(facts.members.map((m) => `${m.kind}:${m.name}:${m.declaredType ?? ''}`)).toEqual(
      expect.arrayContaining(['property:helper:SYBaseCaller', 'ivar:_base:SYBaseCaller']),
    );
    expect(facts.functions.map((fn) => fn.name)).toContain('SYModuleCompute');
    expect(facts.imports.map((imp) => `${imp.kind}:${imp.targetRaw}`)).toEqual(
      expect.arrayContaining([
        'import:SYModuleCaller.h',
        'include:SYModuleSupport.h',
        'module:Foundation',
      ]),
    );
    expect(
      facts.messages.map((msg) => `${msg.receiverKind}:${msg.receiverText}:${msg.selector}`),
    ).toEqual(
      expect.arrayContaining([
        'self:self:traceEvent:',
        'super:super:loadData:completion:',
        'local:typed:loadData:completion:',
        'dynamic:dynamic:loadData:completion:',
        'local:runner:runTask:completion:',
      ]),
    );
    expect(facts.unresolvedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          receiverText: 'dynamic',
          selector: 'loadData:completion:',
          reason: 'id receiver is dynamic',
        }),
      ]),
    );
  });

  it('uses owner, selector, and method kind in stable method identities', () => {
    const facts = collectObjectiveCFacts(parseFixture(), 'SYModuleCaller.m');
    const graph = buildObjectiveCSemanticGraph(facts);
    const methodIds = new Set(
      graph.nodes.filter((node) => node.label === 'Method').map((node) => node.id),
    );

    expect(methodIds).toContain(
      `Method:${objcMethodQualifiedName(objcClassQualifiedName('SYModuleCaller'), '-', 'runTask:completion:')}`,
    );
    expect(methodIds).toContain(
      `Method:${objcMethodQualifiedName(objcClassQualifiedName('SYModuleCaller'), '+', 'sharedCaller')}`,
    );
    expect(methodIds).toContain(
      `Method:${objcMethodQualifiedName(
        objcCategoryQualifiedName('SYModuleCaller', 'Tracing'),
        '-',
        'traceEvent:',
      )}`,
    );
    expect(methodIds.size).toBeGreaterThan(4);
  });
});
