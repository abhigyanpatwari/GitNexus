import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import {
  getLanguageFromFilename,
  getSyntaxLanguageFromFilename,
  SupportedLanguages,
} from 'gitnexus-shared';
import { getLanguageForFileContent } from '../../src/core/ingestion/languages/index.js';
import {
  classifyObjectiveCFileContent,
  objectiveCProvider,
} from '../../src/core/ingestion/languages/objective-c.js';
import {
  buildObjectiveCScopeCaptures,
  buildObjectiveCSemanticGraph,
  collectObjectiveCFacts,
  objcCategoryQualifiedName,
  objcClassQualifiedName,
  objcFunctionQualifiedName,
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

  it('classifies Objective-C headers only from explicit Objective-C syntax', () => {
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
      getLanguageForFileContent(
        'core-foundation-cpp.h',
        '#import <CoreFoundation/CoreFoundation.h>\nclass Widget { int value; };\n',
      ),
    ).toBe(SupportedLanguages.CPlusPlus);
    expect(
      classifyObjectiveCFileContent('framework.h', '#import <Foundation/Foundation.h>\n'),
    ).toBe(false);
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
int first(void), second(void);
`),
      'functions.h',
    );

    expect(facts.functions.map((fn) => fn.name)).toEqual(
      expect.arrayContaining(['add', 'returnsPointer', 'first', 'second']),
    );
    expect(facts.functions.map((fn) => fn.name)).not.toContain('callback');
  });

  it('extracts C helper functions declared inside an Objective-C implementation', () => {
    const facts = collectObjectiveCFacts(
      parseSource(`
@implementation Worker
static int helper(void) { return 1; }
@end
`),
      'Worker.m',
    );

    expect(facts.functions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'helper',
          linkage: 'internal',
          qualifiedName: objcFunctionQualifiedName('helper', 'internal', 'Worker.m'),
          returnType: 'int',
          parameterTypes: ['void'],
        }),
      ]),
    );
  });

  it('keeps internal C function identities file-local while preserving external identities', () => {
    const first = collectObjectiveCFacts(
      parseSource('static int helper(void) { return 1; }\nint shared(void);'),
      'First.m',
    );
    const second = collectObjectiveCFacts(
      parseSource('static int helper(void) { return 2; }\nint shared(void);'),
      'Second.m',
    );

    const firstStatic = first.functions.find((fn) => fn.name === 'helper');
    const secondStatic = second.functions.find((fn) => fn.name === 'helper');
    const firstExternal = first.functions.find((fn) => fn.name === 'shared');
    const secondExternal = second.functions.find((fn) => fn.name === 'shared');

    expect(firstStatic?.qualifiedName).toBe(
      objcFunctionQualifiedName('helper', 'internal', 'First.m'),
    );
    expect(secondStatic?.qualifiedName).toBe(
      objcFunctionQualifiedName('helper', 'internal', 'Second.m'),
    );
    expect(firstStatic?.qualifiedName).not.toBe(secondStatic?.qualifiedName);
    expect(firstExternal?.qualifiedName).toBe(objcFunctionQualifiedName('shared'));
    expect(secondExternal?.qualifiedName).toBe(firstExternal?.qualifiedName);
  });

  it('collects guarded headers and protocol members in optional and required sections', () => {
    const facts = collectObjectiveCFacts(
      parseSource(`
#ifndef WORKER_H
#define WORKER_H
#import "Dep.h"
@interface Worker
- (void)run;
@end
#endif

@protocol P
@optional
- (void)ping;
@property Helper *optionalHelper;
@required
- (void)pong;
@end
`),
      'Worker.h',
    );

    expect(facts.imports).toContainEqual(expect.objectContaining({ targetRaw: 'Dep.h' }));
    expect(facts.containers).toContainEqual(
      expect.objectContaining({ kind: 'class', name: 'Worker' }),
    );
    expect(facts.methods.map((method) => `${method.ownerName}:${method.selector}`)).toEqual(
      expect.arrayContaining(['Worker:run', 'P:ping', 'P:pong']),
    );
    expect(facts.members).toContainEqual(
      expect.objectContaining({ name: 'optionalHelper', declaredType: 'Helper' }),
    );
  });

  it('uses lexical bindings at each message position and keeps bare id bindings dynamic', () => {
    const facts = collectObjectiveCFacts(
      parseSource(`
@protocol P
- (void)ping;
@end
@interface First
- (void)ping;
@end
@interface Second
- (void)ping;
@end
@interface A
+ (void)ping;
@end
@interface Worker
- (void)run:(First *)value;
@end
@implementation Worker
- (void)run:(First *)value {
  id<P> worker;
  id A;
  [value ping];
  { Second *value = nil; [value ping]; }
  [value ping];
  [worker ping];
  [A ping];
}
@end
`),
      'Worker.m',
    );

    const valueMessages = facts.messages.filter(
      (message) => message.receiverText === 'value' && message.selector === 'ping',
    );
    expect(valueMessages.map((message) => message.receiverType?.name)).toEqual([
      'First',
      'Second',
      'First',
    ]);
    expect(facts.messages).toContainEqual(
      expect.objectContaining({
        receiverText: 'worker',
        receiverKind: 'local',
        receiverType: { kind: 'protocol', name: 'P', raw: 'id<P>' },
      }),
    );
    expect(facts.messages).toContainEqual(
      expect.objectContaining({
        receiverText: 'A',
        receiverKind: 'dynamic',
        receiverType: { kind: 'dynamic', raw: 'id' },
      }),
    );
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

  it('resolves a property declared after its caller in a class extension', () => {
    const facts = collectObjectiveCFacts(
      parseSource(`
@interface LaterOwner
@end
@implementation LaterOwner
- (void)run {
  [self.helper performWork];
}
@end
@interface LaterOwner (Private)
@property (nonatomic, strong) Worker *helper;
@end
`),
      'LaterOwner.m',
    );

    expect(facts.messages).toContainEqual(
      expect.objectContaining({
        receiverText: 'self.helper',
        selector: 'performWork',
        receiverKind: 'property',
        receiverType: { kind: 'class', name: 'Worker', raw: 'Worker' },
      }),
    );
    expect(facts.unresolvedMessages).not.toContainEqual(
      expect.objectContaining({ receiverText: 'self.helper' }),
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

  it('keeps angle-bracket system headers out of local import resolution', () => {
    const tree = parseSource('#import "Local.h"\n#import <Foundation/Foundation.h>\n');
    const facts = collectObjectiveCFacts(tree, 'src/Caller.m');
    const captures = buildObjectiveCScopeCaptures(facts, tree.rootNode).filter(
      (capture) => capture['@import.source'] !== undefined,
    );
    const parsed = captures.map((capture) => objectiveCProvider.interpretImport?.(capture));

    expect(parsed.map((entry) => entry?.targetRaw)).toEqual([
      './Local.h',
      '<Foundation/Foundation.h>',
    ]);
    expect(
      objectiveCScopeResolver.resolveImportTarget(
        parsed[1]?.targetRaw ?? '',
        'src/Caller.m',
        new Set(['src/Foundation/Foundation.h']),
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
