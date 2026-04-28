import { describe, it, expect } from 'vitest';
import {
  runExactMatch,
  normalizeContractId,
  buildProviderIndex,
  runWildcardMatch,
} from '../../../src/core/group/matching.js';
import type { StoredContract } from '../../../src/core/group/types.js';

describe('normalizeContractId', () => {
  it('lowercases HTTP method', () => {
    expect(normalizeContractId('http::get::/api/users')).toBe('http::GET::/api/users');
  });

  it('strips trailing slash from HTTP path', () => {
    expect(normalizeContractId('http::GET::/api/users/')).toBe('http::GET::/api/users');
  });

  it('lowercases gRPC package', () => {
    expect(normalizeContractId('grpc::Hr.UserService/GetUser')).toBe(
      'grpc::hr.userservice/GetUser',
    );
  });

  it('preserves case for malformed gRPC id with leading slash (no full-string lowercasing)', () => {
    expect(normalizeContractId('grpc::/MyPkg/DoThing')).toBe('grpc::/MyPkg/DoThing');
  });

  it('handles malformed grpc with leading slash and no package', () => {
    // grpc::/Method — leading slash, no package
    expect(normalizeContractId('grpc::/Method')).toBe('grpc::/Method');
  });

  it('handles grpc with no slash at all', () => {
    // grpc::ServiceName — no slash, ambiguous; MVP: lowercase entire token
    expect(normalizeContractId('grpc::ServiceName')).toBe('grpc::servicename');
  });

  it('trims and lowercases topic', () => {
    expect(normalizeContractId('topic::  Employee.Hired  ')).toBe('topic::employee.hired');
  });

  it('lowercases lib package coordinates', () => {
    expect(normalizeContractId('lib::@Hr/Common::UserDTO')).toBe('lib::@hr/common::userdto');
  });
});

describe('runExactMatch', () => {
  const makeContract = (
    id: string,
    role: 'provider' | 'consumer',
    repo: string,
  ): StoredContract => ({
    contractId: id,
    type: 'http',
    role,
    symbolUid: `uid-${repo}-${id}`,
    symbolRef: { filePath: `src/${repo}.ts`, name: `fn-${id}` },
    symbolName: `fn-${id}`,
    confidence: 0.8,
    meta: {},
    repo,
  });

  it('matches provider and consumer with same contract ID', () => {
    const contracts: StoredContract[] = [
      makeContract('http::GET::/api/users', 'provider', 'backend'),
      makeContract('http::GET::/api/users', 'consumer', 'frontend'),
    ];

    const { matched, unmatched } = runExactMatch(contracts);

    expect(matched).toHaveLength(1);
    expect(matched[0].contractId).toBe('http::GET::/api/users');
    expect(matched[0].matchType).toBe('exact');
    expect(matched[0].confidence).toBe(1.0);
    expect(matched[0].from.repo).toBe('frontend');
    expect(matched[0].to.repo).toBe('backend');
    expect(unmatched).toHaveLength(0);
  });

  it('handles multiple consumers for one provider', () => {
    const contracts: StoredContract[] = [
      makeContract('http::GET::/api/users', 'provider', 'backend'),
      makeContract('http::GET::/api/users', 'consumer', 'frontend'),
      makeContract('http::GET::/api/users', 'consumer', 'bff'),
    ];

    const { matched } = runExactMatch(contracts);
    expect(matched).toHaveLength(2);
  });

  it('reports unmatched contracts', () => {
    const contracts: StoredContract[] = [
      makeContract('http::GET::/api/users', 'provider', 'backend'),
      makeContract('http::GET::/api/orphan', 'consumer', 'frontend'),
    ];

    const { matched, unmatched } = runExactMatch(contracts);
    expect(matched).toHaveLength(0);
    expect(unmatched).toHaveLength(2);
  });

  it('normalizes contract IDs before matching', () => {
    const contracts: StoredContract[] = [
      makeContract('http::GET::/api/users/', 'provider', 'backend'),
      makeContract('http::get::/api/users', 'consumer', 'frontend'),
    ];

    const { matched } = runExactMatch(contracts);
    expect(matched).toHaveLength(1);
  });

  it('does not match contracts within the same repo', () => {
    const contracts: StoredContract[] = [
      makeContract('http::GET::/api/users', 'provider', 'backend'),
      makeContract('http::GET::/api/users', 'consumer', 'backend'),
    ];

    const { matched } = runExactMatch(contracts);
    expect(matched).toHaveLength(0);
  });

  it('matches same-repo contracts with different service boundaries', () => {
    const contracts: StoredContract[] = [
      {
        ...makeContract('http::GET::/api/users', 'provider', 'monorepo'),
        service: 'services/auth',
      },
      {
        ...makeContract('http::GET::/api/users', 'consumer', 'monorepo'),
        service: 'services/gateway',
      },
    ];

    const { matched } = runExactMatch(contracts);
    expect(matched).toHaveLength(1);
    expect(matched[0].from.repo).toBe('monorepo');
    expect(matched[0].to.repo).toBe('monorepo');
    expect(matched[0].from.service).toBe('services/gateway');
    expect(matched[0].to.service).toBe('services/auth');
  });

  it('does not match same-repo contracts with same service', () => {
    const contracts: StoredContract[] = [
      {
        ...makeContract('http::GET::/api/users', 'provider', 'monorepo'),
        service: 'services/auth',
      },
      {
        ...makeContract('http::GET::/api/users', 'consumer', 'monorepo'),
        service: 'services/auth',
      },
    ];

    const { matched } = runExactMatch(contracts);
    expect(matched).toHaveLength(0);
  });

  it('does not match same-repo when only one has service', () => {
    const contracts: StoredContract[] = [
      {
        ...makeContract('http::GET::/api/users', 'provider', 'monorepo'),
        service: 'services/auth',
      },
      makeContract('http::GET::/api/users', 'consumer', 'monorepo'),
    ];

    const { matched } = runExactMatch(contracts);
    expect(matched).toHaveLength(0);
  });

  it('cross-repo matching works regardless of service field', () => {
    const contracts: StoredContract[] = [
      { ...makeContract('http::GET::/api/users', 'provider', 'backend'), service: 'services/auth' },
      { ...makeContract('http::GET::/api/users', 'consumer', 'frontend'), service: 'services/web' },
    ];

    const { matched } = runExactMatch(contracts);
    expect(matched).toHaveLength(1);
    expect(matched[0].from.service).toBe('services/web');
    expect(matched[0].to.service).toBe('services/auth');
  });

  it('matches consumer http::*::path to a concrete provider method on that path', () => {
    const contracts: StoredContract[] = [
      makeContract('http::POST::/api/users', 'provider', 'backend'),
      makeContract('http::*::/api/users', 'consumer', 'frontend'),
    ];

    const { matched, unmatched } = runExactMatch(contracts);
    expect(matched).toHaveLength(1);
    expect(matched[0].contractId).toBe('http::*::/api/users');
    expect(matched[0].to.repo).toBe('backend');
    expect(unmatched).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers for Task 6 tests
// ---------------------------------------------------------------------------
function makeGrpcContract(
  id: string,
  role: 'provider' | 'consumer',
  repo: string,
  overrides: Partial<StoredContract> = {},
): StoredContract {
  return {
    contractId: id,
    type: 'grpc',
    role,
    symbolUid: `uid-${repo}-${id}`,
    symbolRef: { filePath: `src/${repo}.ts`, name: `fn-${id}` },
    symbolName: `fn-${id}`,
    confidence: 0.9,
    meta: {},
    repo,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildProviderIndex
// ---------------------------------------------------------------------------
describe('buildProviderIndex', () => {
  it('test_buildProviderIndex_creates_normalized_keys', () => {
    const contracts: StoredContract[] = [
      makeGrpcContract('grpc::Com.Example.UserService/GetUser', 'provider', 'backend'),
      makeGrpcContract('grpc::Com.Example.UserService/GetUser', 'consumer', 'frontend'),
    ];

    const index = buildProviderIndex(contracts);

    // Only providers should be in the index
    expect(index.size).toBe(1);
    // Key should be normalized (lowercased package)
    expect(index.has('grpc::com.example.userservice/GetUser')).toBe(true);
    expect(index.get('grpc::com.example.userservice/GetUser')).toHaveLength(1);
    expect(index.get('grpc::com.example.userservice/GetUser')![0].role).toBe('provider');
  });
});

// ---------------------------------------------------------------------------
// runExactMatch — gRPC wildcard skip
// ---------------------------------------------------------------------------
describe('runExactMatch — gRPC wildcard handling', () => {
  it('test_runExactMatch_skips_grpc_wildcard_contracts', () => {
    const contracts: StoredContract[] = [
      makeGrpcContract('grpc::com.example.UserService/*', 'consumer', 'frontend'),
      makeGrpcContract('grpc::com.example.UserService/*', 'provider', 'backend'),
    ];

    const { matched, unmatched } = runExactMatch(contracts);

    // gRPC wildcards should NOT be matched in exact pass
    expect(matched).toHaveLength(0);
    // Both should appear in unmatched
    expect(unmatched).toHaveLength(2);
  });

  it('test_runExactMatch_does_not_skip_http_wildcards', () => {
    const contracts: StoredContract[] = [
      {
        contractId: 'http::GET::/api/users',
        type: 'http',
        role: 'provider',
        symbolUid: 'uid-backend-http',
        symbolRef: { filePath: 'src/backend.ts', name: 'fn-http' },
        symbolName: 'fn-http',
        confidence: 0.9,
        meta: {},
        repo: 'backend',
      },
      {
        contractId: 'http::*::/api/users',
        type: 'http',
        role: 'consumer',
        symbolUid: 'uid-frontend-http',
        symbolRef: { filePath: 'src/frontend.ts', name: 'fn-http' },
        symbolName: 'fn-http',
        confidence: 0.9,
        meta: {},
        repo: 'frontend',
      },
    ];

    const { matched } = runExactMatch(contracts);
    // HTTP wildcard should still match via findMatchingKeys
    expect(matched).toHaveLength(1);
    expect(matched[0].contractId).toBe('http::*::/api/users');
  });
});

// ---------------------------------------------------------------------------
// runWildcardMatch
// ---------------------------------------------------------------------------
describe('runWildcardMatch', () => {
  it('test_runWildcardMatch_fq_service_match', () => {
    const consumer = makeGrpcContract('grpc::com.example.UserService/*', 'consumer', 'frontend');
    const provider = makeGrpcContract(
      'grpc::com.example.UserService/GetUser',
      'provider',
      'backend',
    );

    const providerIndex = buildProviderIndex([provider]);
    const { matched } = runWildcardMatch([consumer], providerIndex);

    expect(matched).toHaveLength(1);
    expect(matched[0].from.repo).toBe('frontend');
    expect(matched[0].to.repo).toBe('backend');
  });

  it('test_runWildcardMatch_bare_name_match', () => {
    const consumer = makeGrpcContract('grpc::UserService/*', 'consumer', 'frontend');
    const provider = makeGrpcContract(
      'grpc::com.example.UserService/GetUser',
      'provider',
      'backend',
    );

    const providerIndex = buildProviderIndex([provider]);
    const { matched } = runWildcardMatch([consumer], providerIndex);

    expect(matched).toHaveLength(1);
    expect(matched[0].from.repo).toBe('frontend');
    expect(matched[0].to.repo).toBe('backend');
  });

  it('test_runWildcardMatch_no_match_different_service', () => {
    const consumer = makeGrpcContract('grpc::UserService/*', 'consumer', 'frontend');
    const provider = makeGrpcContract(
      'grpc::com.example.OtherService/GetUser',
      'provider',
      'backend',
    );

    const providerIndex = buildProviderIndex([provider]);
    const { matched, remaining } = runWildcardMatch([consumer], providerIndex);

    expect(matched).toHaveLength(0);
    expect(remaining).toContainEqual(consumer);
  });

  it('test_runWildcardMatch_skips_wildcard_providers', () => {
    const consumer = makeGrpcContract('grpc::com.example.UserService/*', 'consumer', 'frontend');
    const provider = makeGrpcContract('grpc::com.example.UserService/*', 'provider', 'backend');

    const providerIndex = buildProviderIndex([provider]);
    const { matched } = runWildcardMatch([consumer], providerIndex);

    // Wildcard provider key ends with /*, so it should be skipped
    expect(matched).toHaveLength(0);
  });

  it('test_runWildcardMatch_confidence_min', () => {
    const consumer = makeGrpcContract('grpc::com.example.UserService/*', 'consumer', 'frontend', {
      confidence: 0.7,
    });
    const provider = makeGrpcContract(
      'grpc::com.example.UserService/GetUser',
      'provider',
      'backend',
      {
        confidence: 0.5,
      },
    );

    const providerIndex = buildProviderIndex([provider]);
    const { matched } = runWildcardMatch([consumer], providerIndex);

    expect(matched).toHaveLength(1);
    expect(matched[0].confidence).toBe(0.5);
  });

  it('test_runWildcardMatch_matchType_wildcard', () => {
    const consumer = makeGrpcContract('grpc::com.example.UserService/*', 'consumer', 'frontend');
    const provider = makeGrpcContract(
      'grpc::com.example.UserService/GetUser',
      'provider',
      'backend',
    );

    const providerIndex = buildProviderIndex([provider]);
    const { matched } = runWildcardMatch([consumer], providerIndex);

    expect(matched).toHaveLength(1);
    expect(matched[0].matchType).toBe('wildcard');
  });

  it('test_runWildcardMatch_contractId_is_consumers', () => {
    const consumer = makeGrpcContract('grpc::com.example.UserService/*', 'consumer', 'frontend');
    const provider = makeGrpcContract(
      'grpc::com.example.UserService/GetUser',
      'provider',
      'backend',
    );

    const providerIndex = buildProviderIndex([provider]);
    const { matched } = runWildcardMatch([consumer], providerIndex);

    expect(matched).toHaveLength(1);
    expect(matched[0].contractId).toBe('grpc::com.example.UserService/*');
  });
});
