/**
 * Receiver chains over callee and receiver spellings the chain walk used to
 * misread (#3498 shape arm).
 *
 * `extractMixedChain` turns the receiver of `x.save()` into a chain of steps the
 * resolver folds into a type. Each row below is a spelling where the walk read
 * the wrong name, stopped early, or never started, so the call either lost its
 * edge or vanished without a recorded drop:
 *
 * - explicit type arguments inside the callee (`svc.GetTyped<User>()`,
 *   `svc.get_typed::<User>()`, `svc->getTyped<User>()`);
 * - wrappers that denote exactly their operand: C# `svc!` and Swift's
 *   one-element tuple, which is how Swift parses `(x)`;
 * - C# null-conditional access (`svc?.GetUser()`, `user?.Address`,
 *   `repos?[0]`), which splits the receiver and the member across two nodes.
 *
 * A row lists every CALLS target of `member` from `source`, and every
 * `receiver-unresolved` call drop recorded for `member` in that method. A row
 * with no target and one drop is a KNOWN GAP: the chain is now built and
 * visible, but folding it needs something this change does not add (noted on
 * the row).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

interface Row {
  readonly language: string;
  /** Name of the function or method holding the chained call. */
  readonly source: string;
  /** Member called at the end of the chain. */
  readonly member: string;
  /** Every CALLS target id of `member` from `source`, sorted. */
  readonly targets: readonly string[];
  /** Every `receiver-unresolved` call drop for `member` in `source`, as `file:line`. */
  readonly drops: readonly string[];
}

interface LanguageCase {
  readonly language: SupportedLanguages;
  readonly files: Readonly<Record<string, string>>;
  readonly rows: readonly Row[];
}

const CSHARP_MODELS = `using System.Threading.Tasks;

public class Address {
    public void Save() {}
}

public class User {
    public Address Address;
    public void Save() {}
}

public class Service {
    public User GetUser() { return new User(); }
    public async Task<User> GetUserAsync() { return new User(); }
    public User GetTyped<T>() { return new User(); }
}
`;

const RUST_MODELS = `pub struct Address;

impl Address {
    pub fn save(&self) {}
}

pub struct User {
    pub address: Address,
}

impl User {
    pub fn save(&self) {}
}

pub struct Service;

impl Service {
    pub fn get_typed<T>(&self) -> User {
        User { address: Address }
    }
}
`;

const CPP_MODELS = `#pragma once

class Address {
public:
    void save();
};

class User {
public:
    Address addr;
    void save();
};

class Service {
public:
    User* getUser();
    template <typename T>
    T* getTyped();
};
`;

const SWIFT_MODELS = `class Address {
    func save() {}
}

class User {
    var address: Address = Address()
    func save() {}
}

class Service {
    func getUser() -> User { return User() }
    func getUserAsync() async -> User { return User() }
}

class Holder {
    var repo: User = User()
    var users: [User] = []
}
`;

const CASES: readonly LanguageCase[] = [
  {
    language: SupportedLanguages.CSharp,
    files: {
      'Models.cs': CSHARP_MODELS,
      'Main.cs': `public class Caller {
    void ExplicitTypeArgs(Service svc) {
        svc.GetTyped<User>().Save();
    }
    void ExplicitTypeArgsThenField(Service svc) {
        svc.GetTyped<User>().Address.Save();
    }
    void NonNullAssert(Service svc) {
        svc!.GetUser().Save();
    }
    void OptionalChain(Service svc) {
        svc?.GetUser().Save();
    }
    void OptionalTypeArgs(Service svc) {
        svc?.GetTyped<User>().Save();
    }
    void OptionalField(User user) {
        user?.Address.Save();
    }
    void OptionalElement(User[] repos) {
        repos?[0].Save();
    }
}
`,
    },
    rows: [
      {
        language: 'csharp',
        source: 'ExplicitTypeArgs',
        member: 'Save',
        targets: ['Method:Models.cs:User.Save#0'],
        drops: [],
      },
      {
        language: 'csharp',
        source: 'ExplicitTypeArgsThenField',
        member: 'Save',
        targets: ['Method:Models.cs:Address.Save#0'],
        drops: [],
      },
      {
        language: 'csharp',
        source: 'NonNullAssert',
        member: 'Save',
        targets: ['Method:Models.cs:User.Save#0'],
        drops: [],
      },
      {
        language: 'csharp',
        source: 'OptionalChain',
        member: 'Save',
        targets: ['Method:Models.cs:User.Save#0'],
        drops: [],
      },
      {
        language: 'csharp',
        source: 'OptionalTypeArgs',
        member: 'Save',
        targets: ['Method:Models.cs:User.Save#0'],
        drops: [],
      },
      {
        // Resolved before this change too, through the receiver-text cascade.
        // Pinned so the structural walk cannot regress it.
        language: 'csharp',
        source: 'OptionalField',
        member: 'Save',
        targets: ['Method:Models.cs:Address.Save#0'],
        drops: [],
      },
      {
        // KNOWN GAP. The chain `2|repos|i` is now built, so the miss is
        // recorded, but an array-typed parameter (`User[] repos`) gets no
        // type binding yet.
        language: 'csharp',
        source: 'OptionalElement',
        member: 'Save',
        targets: [],
        drops: ['Main.cs:21'],
      },
    ],
  },
  {
    language: SupportedLanguages.Rust,
    files: {
      'models.rs': RUST_MODELS,
      'main.rs': `mod models;
use models::{Address, Service, User};

fn explicit_type_args(svc: &Service) {
    svc.get_typed::<User>().save();
}

fn explicit_type_args_then_field(svc: &Service) {
    svc.get_typed::<User>().address.save();
}
`,
    },
    rows: [
      {
        language: 'rust',
        source: 'explicit_type_args',
        member: 'save',
        targets: ['Function:models.rs:User.save#0'],
        drops: [],
      },
      {
        language: 'rust',
        source: 'explicit_type_args_then_field',
        member: 'save',
        targets: ['Function:models.rs:Address.save#0'],
        drops: [],
      },
    ],
  },
  {
    language: SupportedLanguages.CPlusPlus,
    files: {
      'models.h': CPP_MODELS,
      'main.cpp': `#include "models.h"

void explicitTypeArgs(Service* svc) {
    svc->getTyped<User>()->save();
}
`,
    },
    rows: [
      {
        // KNOWN GAP. The chain step is now `getTyped`, not `getTyped<User>`, but
        // `template <typename T> T* getTyped()` has no return type until the
        // call's type arguments are substituted for `T`.
        language: 'cpp',
        source: 'explicitTypeArgs',
        member: 'save',
        targets: [],
        drops: ['main.cpp:4'],
      },
    ],
  },
  {
    language: SupportedLanguages.Swift,
    files: {
      'models.swift': SWIFT_MODELS,
      'main.swift': `func parenField(holder: Holder) {
    (holder).repo.save()
}

func awaitParen(svc: Service) async {
    (await svc.getUserAsync()).save()
}
`,
    },
    rows: [
      {
        language: 'swift',
        source: 'parenField',
        member: 'save',
        targets: ['Function:models.swift:User.save#0'],
        drops: [],
      },
      {
        // KNOWN GAP. The chain `2|svc|cgetUserAsync|a` is now built, but Swift
        // keeps return types on the Module scope and the fold does not look
        // there yet.
        language: 'swift',
        source: 'awaitParen',
        member: 'save',
        targets: [],
        drops: ['main.swift:6'],
      },
    ],
  },
];

/** Every function or method named `name`, with its 1-based line span. */
function definitionsNamed(
  result: PipelineResult,
  name: string,
): Array<{ filePath: string; firstLine: number; lastLine: number }> {
  const found: Array<{ filePath: string; firstLine: number; lastLine: number }> = [];
  result.graph.forEachNode((node) => {
    if (node.label !== 'Function' && node.label !== 'Method') return;
    if (node.properties.name !== name) return;
    // Graph node lines are 0-based; resolution outcome ranges are 1-based.
    found.push({
      filePath: String(node.properties.filePath),
      firstLine: Number(node.properties.startLine) + 1,
      lastLine: Number(node.properties.endLine) + 1,
    });
  });
  return found;
}

describe.each(CASES)('receiver chain spellings ($language)', ({ language, files, rows }) => {
  // Swift is a vendored optional grammar; a host without its prebuild skips it.
  describe.skipIf(!isLanguageAvailable(language))('with the grammar loaded', () => {
    let root: string;
    let result: PipelineResult;

    beforeAll(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), `gitnexus-chain-spellings-${language}-`));
      writeFixtureRepo(root, files);
      result = await runPipelineFromRepo(root, () => {});
    }, 180000);

    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it.each(rows)(
      '$language: $member called from $source reaches $targets with drops $drops',
      ({ source, member, targets, drops }) => {
        const reached = getRelationships(result, 'CALLS')
          .filter((edge) => edge.source === source && edge.target === member)
          .map((edge) => edge.rel.targetId)
          .sort();
        expect(reached).toEqual(targets);

        const definitions = definitionsNamed(result, source);
        expect(definitions).toHaveLength(1);
        const [definition] = definitions;
        const dropped = getResolutionOutcomes(result)
          .filter((outcome) => outcome.kind === 'suppressed')
          .filter(
            (outcome) =>
              outcome.reason === 'receiver-unresolved' &&
              outcome.siteKind === 'call' &&
              outcome.name === member &&
              outcome.filePath === definition.filePath &&
              outcome.range.startLine >= definition.firstLine &&
              outcome.range.startLine <= definition.lastLine,
          )
          .map((outcome) => `${outcome.filePath}:${outcome.range.startLine}`)
          .sort();
        expect(dropped).toEqual(drops);
      },
    );
  });
});
