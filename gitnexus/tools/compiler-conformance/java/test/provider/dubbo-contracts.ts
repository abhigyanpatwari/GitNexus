import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  buildDubboSites,
  dubboContractId,
  scanDubboJava,
} from '../../../../../src/core/ingestion/languages/java/dubbo-source.js';
import { parseGroupConfig } from '../../../../../src/core/group/config-parser.js';

const API = `package api;
public interface Account {
  String get(Long id);
  String get(String id);
  String list();
}`;
const PROVIDER = `package impl;
import api.Account;
import org.apache.dubbo.config.annotation.DubboService;
@DubboService(interfaceClass = Account.class, group = "accounts", version = "1")
public class AccountService implements Account {
  public String get(Long id) { return ""; }
  public String get(String id) { return ""; }
  public String list() { return ""; }
}`;
const CONSUMER = `package app;
import api.Account;
import org.apache.dubbo.config.annotation.DubboReference;
class Facade {
  @DubboReference(group = "accounts", version = "1") private Account account;
  private String load() { return account.list(); }
}`;

function sites(consumer = CONSUMER, provider = PROVIDER, api = API, extra: string[] = []) {
  const parser = new Parser();
  parser.setLanguage(Java);
  const inputs = [api, provider, consumer, ...extra];
  const files = inputs.map((source, i) => {
    const tree = parser.parse(source);
    assert.equal(tree.rootNode.hasError, false);
    return scanDubboJava(`repo${i}/Source.java`, tree.rootNode);
  });
  const result = buildDubboSites(files);
  return files.map((file) => {
    const list = result.get(file);
    assert.ok(list);
    return list;
  });
}

describe('Dubbo cross-repository source facts', () => {
  it('links a field proxy to a provider through a third repository interface', () => {
    const [api, provider, consumer] = sites();
    assert.ok(
      consumer.some(
        (s) =>
          s.service === 'api.Account' &&
          s.group === 'accounts' &&
          s.version === '1' &&
          s.method === 'list' &&
          s.name === 'load' &&
          s.role === 'consumer',
      ),
    );
    const list = consumer.find((s) => s.method === 'list');
    assert.ok(list);
    const cid = dubboContractId(list, 'list');
    for (const list of [api, provider]) {
      assert.equal(
        list.some(
          (s) => s.role === 'provider' && dubboContractId(s, s.method, s.parameters) === cid,
        ),
        true,
      );
    }
    assert.equal(
      api.some((s) => s.name === 'Account' && s.method === ''),
      true,
    );
  });

  it('keeps provider overload signatures distinct and refuses an ambiguous consumer call', () => {
    const [, providers, consumers] = sites(CONSUMER.replace('account.list()', 'account.get(1L)'));
    assert.deepEqual(
      providers.filter((s) => s.method === 'get').map((s) => s.parameters),
      [['java.lang.Long'], ['java.lang.String']],
    );
    assert.deepEqual(consumers, []);
  });

  it('links an implicitly imported Runnable signature across repositories', () => {
    const endpoints = sites(
      CONSUMER.replace('account.list()', 'account.submit(() -> {})'),
      PROVIDER.replace(
        'public String list()',
        'public String submit(java.lang.Runnable task) { return ""; }\n  public String list()',
      ),
      API.replace('String list();', 'String submit(Runnable task);\n  String list();'),
    );

    assert.deepEqual(
      endpoints.map((contracts) => contracts.find((site) => site.method === 'submit')?.parameters),
      [['java.lang.Runnable'], ['java.lang.Runnable'], ['java.lang.Runnable']],
    );
  });

  it('resolves overloads with different arities', () => {
    const [, , consumers] = sites(
      CONSUMER.replace('account.list()', 'account.get(1L)'),
      PROVIDER,
      API.replace('String get(String id);', 'String get(String id, String tenant);'),
    );
    assert.deepEqual(consumers.find((s) => s.method === 'get')?.parameters, ['java.lang.Long']);
  });

  for (const [key, value] of [
    ['group', 'other'],
    ['version', '2'],
  ])
    it(`does not collapse different ${key} values into one contract`, () => {
      const [, providers, consumers] = sites(
        CONSUMER.replace(`${key} = "${key === 'group' ? 'accounts' : '1'}"`, `${key} = "${value}"`),
      );
      const keys = new Set(providers.map((s) => dubboContractId(s, s.method, s.parameters)));
      assert.equal(
        consumers.every((s) => !keys.has(dubboContractId(s, s.method, s.parameters))),
        true,
      );
    });

  for (const version of ['${dubbo.version}', '${dubbo.version:1}', 'release-${dubbo.version}', '*'])
    it(`skips unresolved/wildcard service identity ${version}`, () => {
      assert.deepEqual(sites(CONSUMER.replace('version = "1"', `version = "${version}"`))[2], []);
    });

  for (const key of ['group', 'version'])
    for (const value of ['team$blue', 'team{blue}', 'team}blue'])
      it(`preserves a static ${key} containing literal punctuation: ${value}`, () => {
        const previous = `${key} = "${key === 'group' ? 'accounts' : '1'}"`;
        const next = `${key} = "${value}"`;
        const [, providers, consumers] = sites(
          CONSUMER.replace(previous, next),
          PROVIDER.replace(previous, next),
        );
        const consumer = consumers.find((s) => s.method === 'list');
        assert.ok(consumer);
        assert.ok(
          providers.some(
            (s) =>
              dubboContractId(s, s.method, s.parameters) ===
              dubboContractId(consumer, consumer.method, consumer.parameters),
          ),
        );
      });

  it('preserves a literal dollar sign in a top-level interface name', () => {
    const rename = (source: string) => source.replaceAll('Account', 'Account$V');
    const [api, provider, consumer] = sites(
      rename(CONSUMER).replace(
        '@DubboReference(',
        '@DubboReference(interfaceName = "api.Account$V", ',
      ),
      rename(PROVIDER),
      rename(API),
    );
    for (const contracts of [api, provider, consumer])
      assert.ok(contracts.some((s) => s.service === 'api.Account$V' && s.method === 'list'));
  });

  it('skips constant-backed group values rather than treating them as default', () => {
    assert.deepEqual(sites(CONSUMER.replace('group = "accounts"', 'group = GROUP'))[2], []);
  });

  it('recognizes legacy Dubbo annotations and inferred provider interfaces', () => {
    const consumer = CONSUMER.replace(
      'org.apache.dubbo.config.annotation.DubboReference',
      'com.alibaba.dubbo.config.annotation.Reference',
    ).replace('@DubboReference', '@Reference');
    const provider = PROVIDER.replace(
      'org.apache.dubbo.config.annotation.DubboService',
      'com.alibaba.dubbo.config.annotation.Service',
    ).replace('@DubboService(interfaceClass = Account.class, ', '@Service(');
    const [, p, c] = sites(consumer, provider);
    assert.equal(
      p.some((s) => s.method === 'list'),
      true,
    );
    assert.equal(
      c.some((s) => s.method === 'list'),
      true,
    );
  });

  it('recognizes fully qualified annotations and interfaceName', () => {
    const consumer = CONSUMER.replace(
      '@DubboReference(',
      '@org.apache.dubbo.config.annotation.DubboReference(interfaceName = "api.Account", ',
    );
    assert.equal(
      sites(consumer)[2].some((s) => s.method === 'list'),
      true,
    );
  });

  it('does not interpret Spring Service as a Dubbo provider', () => {
    assert.deepEqual(
      sites(
        CONSUMER,
        PROVIDER.replace(
          'org.apache.dubbo.config.annotation.DubboService',
          'org.springframework.stereotype.Service',
        ).replace('@DubboService', '@Service'),
      )[1],
      [],
    );
  });

  it('requires an imported or qualified Dubbo annotation', () => {
    assert.deepEqual(
      sites(CONSUMER.replace('import org.apache.dubbo.config.annotation.DubboReference;', ''))[2],
      [],
    );
  });

  it('ignores a parameter that shadows an injected field', () => {
    assert.deepEqual(sites(CONSUMER.replace('load()', 'load(Account account)'))[2], []);
  });

  it('keeps this.field calls when a parameter shadows the field name', () => {
    assert.equal(
      sites(
        CONSUMER.replace('load()', 'load(Account account)').replace(
          'return account.',
          'return this.account.',
        ),
      )[2].some((s) => s.method === 'list'),
      true,
    );
  });

  it('ignores a locally shadowed proxy', () => {
    assert.deepEqual(
      sites(
        CONSUMER.replace(
          'return account.list();',
          'Account account = null; return account.list();',
        ),
      )[2],
      [],
    );
  });

  for (const [label, body, expected] of [
    [
      'a later declaration',
      'String result = account.list(); Account account = null; return result;',
      true,
    ],
    [
      'an ended inner block',
      '{ Account account = null; account.list(); } return account.list();',
      true,
    ],
    ['an active inner block', '{ Account account = null; return account.list(); }', false],
    ['an ended lambda', 'stream.map(account -> account.list()); return account.list();', true],
    ['a typed lambda parameter', 'return stream.map((Account account) -> account.list());', false],
    [
      'an active catch parameter',
      'try { work(); } catch (Exception account) { return account.list(); } return "";',
      false,
    ],
    [
      'an ended catch parameter',
      'try { work(); } catch (Exception account) { account.list(); } return account.list();',
      true,
    ],
    [
      'an active loop variable',
      'for (Account account = null; condition; step()) { account.list(); } return "";',
      false,
    ],
    [
      'an ended loop variable',
      'for (Account account = null; condition; step()) { account.list(); } return account.list();',
      true,
    ],
    [
      'an enhanced loop variable',
      'for (Account account : accounts) { account.list(); } return "";',
      false,
    ],
    [
      'an enhanced loop iterable',
      'for (Account account : account.list()) { account.list(); } return "";',
      true,
    ],
    [
      'an active resource variable',
      'try (Account account = open()) { return account.list(); }',
      false,
    ],
    [
      'a resource outside the catch scope',
      'try (Account account = open()) { work(); } catch (Exception ex) { return account.list(); } return "";',
      true,
    ],
    [
      'a resource outside the finally scope',
      'try (Account account = open()) { work(); } finally { account.list(); } return "";',
      true,
    ],
    [
      'a preceding switch declaration',
      'switch (n) { case 1: Account account = null; case 2: account.list(); } return "";',
      false,
    ],
  ] as const)
    it(`resolves field shadowing at the call site: ${label}`, () => {
      const consumers = sites(CONSUMER.replace('return account.list();', body))[2];
      assert.equal(
        consumers.some((s) => s.method === 'list'),
        expected,
      );
    });

  it('skips reassigned fields', () => {
    assert.deepEqual(
      sites(
        CONSUMER.replace('return account.list();', 'this.account = other; return account.list();'),
      )[2],
      [],
    );
  });

  for (const [label, source, expected] of [
    [
      'a reassigned method parameter',
      CONSUMER.replace('load()', 'load(Account account)').replace(
        'return account.list();',
        'account = null; return this.account.list();',
      ),
      true,
    ],
    [
      'a reassigned local with an explicit field call',
      CONSUMER.replace(
        'return account.list();',
        'Account account = null; account = null; return this.account.list();',
      ),
      true,
    ],
    [
      'a reassigned local in an ended block',
      CONSUMER.replace(
        'return account.list();',
        '{ Account account = null; account = null; } return account.list();',
      ),
      true,
    ],
    [
      'a reassigned constructor parameter',
      CONSUMER.replace(
        'private String load()',
        'Facade(Account account) { account = null; } private String load()',
      ),
      true,
    ],
    [
      'a reassigned initializer local',
      CONSUMER.replace(
        'private String load()',
        '{ Account account = null; account = null; } private String load()',
      ),
      true,
    ],
    [
      'a reassigned lambda parameter',
      CONSUMER.replace(
        'return account.list();',
        'stream.map(account -> { account = null; return this.account.list(); }); return "";',
      ),
      true,
    ],
    [
      'a reassigned catch parameter',
      CONSUMER.replace(
        'return account.list();',
        'try { work(); } catch (Exception account) { account = null; return this.account.list(); } return "";',
      ),
      true,
    ],
    [
      'an unqualified field assignment',
      CONSUMER.replace('return account.list();', 'account = other; return this.account.list();'),
      false,
    ],
    [
      'a field assignment in a constructor',
      CONSUMER.replace(
        'private String load()',
        'Facade(Account account) { this.account = account; } private String load()',
      ),
      false,
    ],
    [
      'a field assignment in an initializer',
      CONSUMER.replace('private String load()', '{ account = other; } private String load()'),
      false,
    ],
    [
      'a field assignment after a shadowing scope ends',
      CONSUMER.replace(
        'return account.list();',
        '{ Account account = null; account = null; } account = other; return this.account.list();',
      ),
      false,
    ],
  ] as const)
    it(`distinguishes proxy writes from local assignments: ${label}`, () => {
      assert.equal(
        sites(source)[2].some((s) => s.method === 'list'),
        expected,
      );
    });

  it('does not scan strings/comments as invocations', () => {
    assert.deepEqual(
      sites(
        CONSUMER.replace(
          'return account.list();',
          '/* account.list(); */ return "account.list()";',
        ),
      )[2],
      [],
    );
  });

  it('does not conflate identical interface names from different packages', () => {
    const other = API.replace('package api;', 'package other;');
    const [, , c] = sites(
      CONSUMER.replace('import api.Account;', 'import other.Account;'),
      PROVIDER,
      API,
      [other],
    );
    assert.equal(
      c.every((s) => s.service === 'other.Account'),
      true,
    );
    assert.ok(c.length > 0);
  });

  it('refuses duplicate FQNs across group members', () => {
    assert.deepEqual(sites(CONSUMER, PROVIDER, API, [API])[2], []);
  });

  it('does not hide unresolved overloads when selecting a consumer target', () => {
    assert.deepEqual(
      sites(
        CONSUMER.replace('account.list()', 'account.get(1L)'),
        PROVIDER,
        API.replace('String get(String id);', 'String get(Unknown id);'),
      )[2],
      [],
    );
  });

  it('does not hide varargs overloads when selecting a consumer target', () => {
    assert.deepEqual(
      sites(
        CONSUMER.replace('account.list()', 'account.get(1L)'),
        PROVIDER,
        API.replace('String get(String id);', 'String get(String... ids);'),
      )[2],
      [],
    );
  });

  for (const sibling of [
    'String get(Unknown id, String tenant);',
    '<T> String get(T id, String tenant);',
    'String get(String tenant, String region, String... ids);',
  ])
    it(`preserves a supported overload with a different applicable arity: ${sibling}`, () => {
      const [api, provider, consumer] = sites(
        CONSUMER.replace('account.list()', 'account.get(1L)'),
        PROVIDER,
        API.replace('String get(String id);', sibling),
      );
      for (const contracts of [api, provider, consumer])
        assert.ok(
          contracts.some((s) => s.method === 'get' && s.parameters[0] === 'java.lang.Long'),
        );
    });

  it('keeps provider contracts when a generic sibling makes the consumer ambiguous', () => {
    const [api, provider, consumer] = sites(
      CONSUMER.replace('account.list()', 'account.get(1L)'),
      PROVIDER,
      API.replace('String get(String id);', '<T> String get(T id);'),
    );
    assert.deepEqual(consumer, []);
    for (const contracts of [api, provider])
      assert.ok(contracts.some((s) => s.method === 'get' && s.parameters[0] === 'java.lang.Long'));
  });

  it('keeps array rank in parameter identities', () => {
    const [, p, c] = sites(
      CONSUMER.replace('account.list()', 'account.get(ids)'),
      PROVIDER.replace('Long id', 'Long[] id'),
      API.replace('Long id', 'Long[] id').replace('String get(String id);', ''),
    );
    assert.deepEqual(c.find((s) => s.method === 'get')?.parameters, ['java.lang.Long[]']);
    assert.ok(p.some((s) => s.method === 'get' && s.parameters[0] === 'java.lang.Long[]'));
  });

  it('skips a lambda parameter that shadows the injected field', () => {
    assert.deepEqual(
      sites(
        CONSUMER.replace('return account.list();', 'return stream.map(account -> account.list());'),
      )[2],
      [],
    );
  });

  it('does not attribute nested class calls to outer proxy fields', () => {
    assert.deepEqual(
      sites(
        CONSUMER.replace(
          'return account.list();',
          'class Inner { Account account; String f() { return account.list(); } } return "";',
        ),
      )[2],
      [],
    );
  });

  it('resolves a unique wildcard interface import', () => {
    assert.ok(
      sites(CONSUMER.replace('import api.Account;', 'import api.*;'))[2].some(
        (s) => s.method === 'list',
      ),
    );
  });

  it('does not export a class under an interface it does not implement', () => {
    assert.deepEqual(sites(CONSUMER, PROVIDER.replace(' implements Account', ''))[1], []);
  });

  it('leaves inherited interface methods unresolved rather than guessing an incomplete overload set', () => {
    assert.deepEqual(
      sites(
        CONSUMER,
        PROVIDER,
        API.replace('interface Account {', 'interface Account extends Parent {'),
      )[2],
      [],
    );
  });

  it('preserves service name case and delimits identity without collisions', () => {
    const key = { service: 'api.Account', group: 'a:b', version: 'c' };
    assert.notEqual(dubboContractId(key), dubboContractId({ ...key, service: 'api.account' }));
    assert.notEqual(dubboContractId(key), dubboContractId({ ...key, group: 'a', version: 'b:c' }));
  });

  it('does not expose a disabled provider', () => {
    assert.deepEqual(
      sites(CONSUMER, PROVIDER.replace('@DubboService(', '@DubboService(export = false, '))[1],
      [],
    );
  });

  it('does not mistake a GenericService field for a typed proxy', () => {
    assert.deepEqual(
      sites(
        CONSUMER.replace(
          '@DubboReference(',
          '@DubboReference(interfaceClass = Account.class, ',
        ).replace('private Account account', 'private GenericService account'),
      )[2],
      [],
    );
  });

  it('skips generic interfaces instead of treating a type parameter as java.lang.String', () => {
    assert.deepEqual(
      sites(CONSUMER, PROVIDER, API.replace('interface Account', 'interface Account<String>'))[2],
      [],
    );
  });
});

describe('Dubbo group configuration', () => {
  const yaml = 'version: 1\nname: demo\nrepos:\n  consumer: consumer\n';
  it('is disabled for existing groups', () =>
    assert.equal(parseGroupConfig(yaml).detect.dubbo, false));
  it('can be enabled explicitly', () =>
    assert.equal(parseGroupConfig(yaml + 'detect:\n  dubbo: true\n').detect.dubbo, true));
  it('rejects non-boolean flags', () =>
    assert.throws(() => parseGroupConfig(yaml + 'detect:\n  dubbo: yes\n'), /detect\.dubbo/));
});
