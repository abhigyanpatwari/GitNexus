import { describe, expect, it } from 'vitest';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { getRelationships, useFixture } from './helpers.js';

// isLanguageAvailable only says the grammar module loaded; probe the parser so
// a grammar that fails in setLanguage skips the suite instead of failing it.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

/**
 * `import 'x.dart' as p show A;` and `... as p hide B;` limit what `p.` can
 * name (Dart spec, "Imports": the combinators filter the imported namespace
 * before it is bound to the prefix). Every class here declares `save`,
 * `create` and `self`, so a name reached through a filtered-out member lands
 * on a different owner instead of on nothing.
 */
const type = (name: string): string =>
  `class ${name} { void save() {} static ${name} create() => ${name}(); ${name} self() => this; }`;

/**
 * One function per way of reaching `prefix.type` or `prefix.factory`, named
 * `<form><Consumer><suffix>`. A deferred library offers no type annotations
 * (its types are not usable before `loadLibrary`), so that form has the
 * expression consumers only.
 */
function consumers(
  form: string,
  prefix: string,
  suffix: string,
  typeName: string,
  factory: string,
  deferred = false,
): string {
  const fn = (consumer: string, body: string): string =>
    deferred
      ? `Future<void> ${form}${consumer}${suffix}() async { await ${prefix}.loadLibrary(); ${body} }`
      : `void ${form}${consumer}${suffix}() { ${body} }`;
  const expressions = [
    fn('Constructs', `${prefix}.${typeName}();`),
    fn('ConstructsLocal', `final value = ${prefix}.${typeName}(); value.save();`),
    fn('ConstructsChain', `${prefix}.${typeName}().self().save();`),
    fn('Statics', `${prefix}.${typeName}.create().save();`),
    fn('Calls', `${prefix}.${factory}().save();`),
    fn('CallsLocal', `final value = ${prefix}.${factory}(); value.save();`),
  ];
  const annotations = [
    `void ${form}Types${suffix}(${prefix}.${typeName} value) { value.save(); }`,
    `Future<${prefix}.${typeName}> ${form}Produces${suffix}() async => throw 'unused';`,
    `Future<void> ${form}Awaits${suffix}() async { final value = await ${form}Produces${suffix}(); value.save(); }`,
  ];
  return [...expressions, ...(deferred ? [] : annotations)].join('\n');
}

/** What a prefix that reaches only `leaf.dart` resolves for one visible class and its factory. */
const singleLibrary = (
  form: string,
  suffix = '',
  typeName = 'User',
  factory = 'make',
): string[] => [
  `${form}Awaits${suffix} -> Function:${form}.dart:${form}Produces${suffix}`,
  `${form}Awaits${suffix} -> Method:leaf.dart:${typeName}.save#0`,
  `${form}Calls${suffix} -> Function:leaf.dart:${factory}`,
  `${form}Calls${suffix} -> Method:leaf.dart:${typeName}.save#0`,
  `${form}CallsLocal${suffix} -> Function:leaf.dart:${factory}`,
  `${form}CallsLocal${suffix} -> Method:leaf.dart:${typeName}.save#0`,
  `${form}Constructs${suffix} -> Class:leaf.dart:${typeName}`,
  `${form}ConstructsChain${suffix} -> Class:leaf.dart:${typeName}`,
  `${form}ConstructsLocal${suffix} -> Class:leaf.dart:${typeName}`,
  `${form}ConstructsLocal${suffix} -> Method:leaf.dart:${typeName}.save#0`,
  `${form}Statics${suffix} -> Method:leaf.dart:${typeName}.create#0`,
  `${form}Types${suffix} -> Method:leaf.dart:${typeName}.save#0`,
];

const FORMS = [
  {
    form: 'show',
    visible: singleLibrary('show'),
    // The awaited producer is a function of the importing file itself.
    hidden: ['showAwaitsHidden -> Function:show.dart:showProducesHidden'],
  },
  {
    form: 'hide',
    visible: singleLibrary('hide'),
    hidden: ['hideAwaitsHidden -> Function:hide.dart:hideProducesHidden'],
  },
  {
    // The prefix names facade.dart, which re-exports leaf.dart: the filter is
    // the importing statement's, whichever file declares the name.
    form: 'facade',
    visible: singleLibrary('facade'),
    hidden: ['facadeAwaitsHidden -> Function:facade.dart:facadeProducesHidden'],
  },
  {
    // Three imports share the prefix: two of leaf.dart with different `show`
    // lists, one of more.dart. `two.User` is leaf.dart's class: more.dart
    // declares a `User` as well, but its own import does not show it.
    form: 'shared',
    visible: [
      'sharedAwaits -> Function:shared.dart:sharedProduces',
      'sharedAwaits -> Method:leaf.dart:User.save#0',
      'sharedAwaitsSecond -> Function:shared.dart:sharedProducesSecond',
      'sharedAwaitsSecond -> Method:more.dart:Extra.save#0',
      'sharedCalls -> Function:leaf.dart:make',
      'sharedCallsLocal -> Function:leaf.dart:make',
      'sharedCallsLocalSecond -> Function:more.dart:makeExtra',
      'sharedCallsSecond -> Function:more.dart:makeExtra',
      'sharedConstructs -> Class:leaf.dart:User',
      'sharedConstructsChain -> Class:leaf.dart:User',
      'sharedConstructsChainSecond -> Class:more.dart:Extra',
      'sharedConstructsLocal -> Class:leaf.dart:User',
      'sharedConstructsLocal -> Method:leaf.dart:User.save#0',
      'sharedConstructsLocalSecond -> Class:more.dart:Extra',
      'sharedConstructsLocalSecond -> Method:more.dart:Extra.save#0',
      'sharedConstructsSecond -> Class:more.dart:Extra',
      'sharedStatics -> Method:leaf.dart:User.create#0',
      'sharedStaticsSecond -> Method:more.dart:Extra.create#0',
      'sharedTypes -> Method:leaf.dart:User.save#0',
      'sharedTypesSecond -> Method:more.dart:Extra.save#0',
    ],
    hidden: ['sharedAwaitsHidden -> Function:shared.dart:sharedProducesHidden'],
  },
  {
    form: 'deferred',
    visible: [
      'deferredCalls -> Function:leaf.dart:make',
      'deferredCalls -> Method:leaf.dart:User.save#0',
      'deferredCallsLocal -> Function:leaf.dart:make',
      'deferredCallsLocal -> Method:leaf.dart:User.save#0',
      'deferredConstructs -> Class:leaf.dart:User',
      'deferredConstructsChain -> Class:leaf.dart:User',
      'deferredConstructsLocal -> Class:leaf.dart:User',
      'deferredConstructsLocal -> Method:leaf.dart:User.save#0',
      'deferredStatics -> Method:leaf.dart:User.create#0',
    ],
    hidden: [],
  },
];

describe.skipIf(!dartAvailable)('Dart prefixed imports with show and hide', () => {
  const run = useFixture('dart-prefixed-show-hide', {
    'leaf.dart': `${type('User')}\n${type('Other')}\nUser make() => User();\nOther makeOther() => Other();\n`,
    'more.dart': `${type('Extra')}\n${type('User')}\nExtra makeExtra() => Extra();\n`,
    'plain.dart': [
      "import 'leaf.dart' as all;",
      consumers('plain', 'all', '', 'User', 'make'),
      consumers('plain', 'all', 'Second', 'Other', 'makeOther'),
    ].join('\n'),
    'show.dart': [
      "import 'leaf.dart' as s show User, make;",
      consumers('show', 's', '', 'User', 'make'),
      consumers('show', 's', 'Hidden', 'Other', 'makeOther'),
    ].join('\n'),
    'hide.dart': [
      "import 'leaf.dart' as h hide Other, makeOther;",
      consumers('hide', 'h', '', 'User', 'make'),
      consumers('hide', 'h', 'Hidden', 'Other', 'makeOther'),
    ].join('\n'),
    'exports.dart': "export 'leaf.dart';\n",
    'facade.dart': [
      "import 'exports.dart' as f show User, make;",
      consumers('facade', 'f', '', 'User', 'make'),
      consumers('facade', 'f', 'Hidden', 'Other', 'makeOther'),
    ].join('\n'),
    'shared.dart': [
      "import 'leaf.dart' as two show User;",
      "import 'leaf.dart' as two show make;",
      "import 'more.dart' as two show Extra, makeExtra;",
      consumers('shared', 'two', '', 'User', 'make'),
      consumers('shared', 'two', 'Second', 'Extra', 'makeExtra'),
      consumers('shared', 'two', 'Hidden', 'Other', 'makeOther'),
    ].join('\n'),
    'deferred.dart': [
      "import 'leaf.dart' deferred as d show User, make;",
      consumers('deferred', 'd', '', 'User', 'make', true),
      consumers('deferred', 'd', 'Hidden', 'Other', 'makeOther', true),
    ].join('\n'),
  });

  /** Every CALLS edge leaving the functions of one import form, hidden-name consumers or the rest. */
  const calls = (form: string, hidden: boolean): string[] =>
    getRelationships(run(), 'CALLS')
      .filter((edge) => edge.source.startsWith(form) && edge.source.endsWith('Hidden') === hidden)
      .map((edge) => `${edge.source} -> ${edge.rel.targetId}`)
      .sort();

  it('plain: without a combinator both classes resolve, each to its own owner', () => {
    expect(calls('plain', false)).toEqual(
      [...singleLibrary('plain'), ...singleLibrary('plain', 'Second', 'Other', 'makeOther')].sort(),
    );
  });

  it.each(FORMS)('$form: a visible name resolves to its own library', ({ form, visible }) => {
    expect(calls(form, false)).toEqual(visible);
  });

  it.each(FORMS)('$form: a filtered-out name resolves nothing', ({ form, hidden }) => {
    expect(calls(form, true)).toEqual(hidden);
  });
});
