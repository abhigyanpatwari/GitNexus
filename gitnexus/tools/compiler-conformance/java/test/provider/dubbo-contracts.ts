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

  for (const version of ['${dubbo.version}', '*'])
    it(`skips unresolved/wildcard service identity ${version}`, () => {
      assert.deepEqual(sites(CONSUMER.replace('version = "1"', `version = "${version}"`))[2], []);
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

  it('skips reassigned fields', () => {
    assert.deepEqual(
      sites(
        CONSUMER.replace('return account.list();', 'this.account = other; return account.list();'),
      )[2],
      [],
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
