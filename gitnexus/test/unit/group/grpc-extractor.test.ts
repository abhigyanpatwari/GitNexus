import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const { parseSourceSafeSpy } = vi.hoisted(() => ({ parseSourceSafeSpy: vi.fn() }));

vi.mock('../../../src/core/tree-sitter/safe-parse.js', async () => {
  const { buildSafeParseMock } = await import('../../helpers/parse-source-safe-mock.js');
  return buildSafeParseMock(parseSourceSafeSpy);
});
import {
  GrpcExtractor,
  buildProtoMap,
  resolveProtoConflict,
  serviceContractId,
} from '../../../src/core/group/extractors/grpc-extractor.js';
import type { ProtoServiceInfo } from '../../../src/core/group/extractors/grpc-extractor.js';
import { buildProviderIndex, runWildcardMatch } from '../../../src/core/group/matching.js';
import type { RepoHandle } from '../../../src/core/group/types.js';
import { _captureLogger } from '../../../src/core/logger.js';

describe('GrpcExtractor', () => {
  let tmpDir: string;
  let extractor: GrpcExtractor;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-grpc-'));
    extractor = new GrpcExtractor();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/app',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  describe('proto file parsing', () => {
    it('test_extract_proto_service_single_rpc_returns_provider', async () => {
      writeFile(
        'proto/auth.proto',
        `syntax = "proto3";
package auth;
service AuthService {
  rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(1);
      expect(providers[0].contractId).toBe('grpc::auth.AuthService/Login');
      expect(providers[0].confidence).toBe(0.85);
      expect(providers[0].symbolRef.filePath).toBe('proto/auth.proto');
    });

    it('test_extract_proto_service_multiple_rpcs_returns_all', async () => {
      writeFile(
        'api/user.proto',
        `syntax = "proto3";
package hr.user.v1;
service UserService {
  rpc GetUser (GetUserRequest) returns (UserResponse);
  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);
  rpc DeleteUser (DeleteUserRequest) returns (Empty);
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(3);
      const ids = providers.map((c) => c.contractId).sort();
      expect(ids).toEqual([
        'grpc::hr.user.v1.UserService/DeleteUser',
        'grpc::hr.user.v1.UserService/GetUser',
        'grpc::hr.user.v1.UserService/ListUsers',
      ]);
    });

    it('test_extract_proto_without_package_uses_service_only', async () => {
      writeFile(
        'service.proto',
        `syntax = "proto3";
service HealthCheck {
  rpc Check (HealthRequest) returns (HealthResponse);
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts).toHaveLength(1);
      expect(contracts[0].contractId).toBe('grpc::HealthCheck/Check');
    });

    it('test_extract_proto_with_google_api_http_nested_braces', async () => {
      writeFile(
        'api/gateway.proto',
        `syntax = "proto3";
package gateway.v1;

import "google/api/annotations.proto";

service GatewayService {
  rpc GetUser (GetUserRequest) returns (UserResponse) {
    option (google.api.http) = {
      get: "/v1/users/{user_id}"
    };
  }
  rpc CreateUser (CreateUserRequest) returns (UserResponse) {
    option (google.api.http) = {
      post: "/v1/users"
      body: "*"
    };
  }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter(
        (c) => c.role === 'provider' && c.symbolRef.filePath === 'api/gateway.proto',
      );

      expect(providers).toHaveLength(2);
      const ids = providers.map((c) => c.contractId).sort();
      expect(ids).toEqual([
        'grpc::gateway.v1.GatewayService/CreateUser',
        'grpc::gateway.v1.GatewayService/GetUser',
      ]);
    });

    it('test_extract_proto_with_multiple_services', async () => {
      writeFile(
        'api/multi.proto',
        `syntax = "proto3";
package multi;

service ServiceA {
  rpc MethodA (Req) returns (Res);
}

service ServiceB {
  rpc MethodB1 (Req) returns (Res);
  rpc MethodB2 (Req) returns (Res);
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter(
        (c) => c.role === 'provider' && c.symbolRef.filePath === 'api/multi.proto',
      );

      expect(providers).toHaveLength(3);
      const ids = providers.map((c) => c.contractId).sort();
      expect(ids).toEqual([
        'grpc::multi.ServiceA/MethodA',
        'grpc::multi.ServiceB/MethodB1',
        'grpc::multi.ServiceB/MethodB2',
      ]);
    });

    it('test_extract_proto_with_nested_option_blocks_in_rpc', async () => {
      writeFile(
        'api/nested.proto',
        `syntax = "proto3";
package nested;

service DeepService {
  rpc DeepMethod (Req) returns (Res) {
    option (google.api.http) = {
      post: "/v1/deep"
      body: "*"
      additional_bindings {
        get: "/v1/deep/{id}"
      }
    };
  }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter(
        (c) => c.role === 'provider' && c.symbolRef.filePath === 'api/nested.proto',
      );

      expect(providers).toHaveLength(1);
      expect(providers[0].contractId).toBe('grpc::nested.DeepService/DeepMethod');
    });

    it('test_extract_proto_malformed_unclosed_brace_skips_service', async () => {
      writeFile(
        'api/broken.proto',
        `syntax = "proto3";
package broken;

service IncompleteService {
  rpc SomeMethod (Req) returns (Res);
  // Missing closing brace — EOF before depth returns to 0
`,
      );

      // Should not throw; incomplete service is silently skipped
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter(
        (c) => c.role === 'provider' && c.symbolRef.filePath === 'api/broken.proto',
      );

      // The old regex would find partial match; the new parser should skip it
      expect(providers).toHaveLength(0);
    });

    it('test_extract_proto_ignores_braces_inside_string_literals', async () => {
      // Regression for a known parser limitation: braces inside string
      // literals used to be counted as real service-body braces, which
      // would terminate the service early and drop methods after the
      // offending string.
      writeFile(
        'api/strings.proto',
        `syntax = "proto3";
package strings;

service TrickyService {
  rpc First (Req) returns (Res) {
    option (google.api.http).additional_bindings = {
      post: "/v1/first";
    };
  }
  // Previously the "{" inside this literal would close the service body.
  option deprecated_reason = "use NewService { instead";
  rpc Second (Req) returns (Res);
  rpc Third (Req) returns (Res);
}
`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const protoProviders = contracts.filter(
        (c) => c.role === 'provider' && c.symbolRef.filePath === 'api/strings.proto',
      );
      // All three methods must be extracted even though a string literal
      // contains an unbalanced "{".
      expect(protoProviders.map((c) => c.symbolName).sort()).toEqual([
        'TrickyService.First',
        'TrickyService.Second',
        'TrickyService.Third',
      ]);
    });

    it('test_extract_proto_ignores_braces_inside_comments', async () => {
      writeFile(
        'api/commented.proto',
        `syntax = "proto3";
package commented;

service Svc {
  // TODO: move { or } from this comment — parser used to count them
  /* A block comment with { unbalanced braces } */
  rpc Alpha (Req) returns (Res);
  // }} end of the method block (in comment)
  rpc Beta (Req) returns (Res);
}
`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const protoProviders = contracts.filter(
        (c) => c.role === 'provider' && c.symbolRef.filePath === 'api/commented.proto',
      );
      expect(protoProviders.map((c) => c.symbolName).sort()).toEqual(['Svc.Alpha', 'Svc.Beta']);
    });
  });

  describe('Go server detection', () => {
    it('test_extract_go_register_server_returns_provider', async () => {
      writeFile(
        'cmd/server/main.go',
        `package main

import pb "example.com/proto/auth"

func main() {
    srv := grpc.NewServer()
    pb.RegisterAuthServiceServer(srv, &authServer{})
    srv.Serve(lis)
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers[0].contractId).toContain('grpc::');
      expect(providers[0].contractId).toContain('AuthService');
      expect(providers[0].confidence).toBe(0.65);
    });

    it('test_extract_go_unimplemented_server_returns_provider', async () => {
      writeFile(
        'internal/server.go',
        `package server

type authServer struct {
    pb.UnimplementedAuthServiceServer
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers[0].contractId).toContain('AuthService');
    });
  });

  describe('Go client detection', () => {
    it('test_extract_go_new_client_returns_consumer', async () => {
      writeFile(
        'internal/client.go',
        `package client

import pb "example.com/proto/auth"

func NewAuthClient(conn *grpc.ClientConn) pb.AuthServiceClient {
    return pb.NewAuthServiceClient(conn)
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.length).toBeGreaterThanOrEqual(1);
      expect(consumers[0].contractId).toContain('AuthService');
      expect(consumers[0].confidence).toBe(0.55);
    });
  });

  describe('Java detection', () => {
    it('test_extract_java_grpc_service_annotation_returns_provider', async () => {
      writeFile(
        'src/main/java/AuthGrpcService.java',
        `@GrpcService
public class AuthGrpcService extends AuthServiceGrpc.AuthServiceImplBase {
    @Override
    public void login(LoginRequest req, StreamObserver<LoginResponse> obs) {}
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers[0].contractId).toContain('AuthService');
      expect(providers[0].confidence).toBe(0.65);
    });

    it('test_extract_java_blocking_stub_returns_consumer', async () => {
      writeFile(
        'src/main/java/AuthClient.java',
        `public class AuthClient {
    private final AuthServiceGrpc.AuthServiceBlockingStub stub;
    public AuthClient(ManagedChannel ch) {
        this.stub = AuthServiceGrpc.newBlockingStub(ch);
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.length).toBeGreaterThanOrEqual(1);
      expect(consumers[0].contractId).toContain('AuthService');
      expect(consumers[0].confidence).toBe(0.55);
    });
  });

  // ─── Java client-jar / import-derived FQN ─────────────────────────
  // The "client-jar" architecture is the dominant pattern for Java
  // gRPC microservices: the service owner publishes a pre-compiled
  // stub jar to a Maven repository, and consumer repos depend on the
  // jar instead of carrying the originating `.proto` files. Examples:
  // gRPC official quickstart, Alibaba HSF, ByteDance KiteX-Java,
  // google-cloud-java SDK.
  //
  // Before this fix, the extractor only resolved a fully-qualified
  // contract id (`grpc::<package>.<Service>/*`) when the consumer
  // repo also carried a matching `.proto` file. Client-jar consumers
  // had no proto, so they fell back to a short-name contract id
  // (`grpc::<Service>/*`) that never matched the provider repo's
  // package-qualified contract id — cross-repo grpc cross-link count
  // dropped to zero on every realistic Java micro-service group.
  //
  // The fix derives the FQN directly from the consumer file's `import
  // <pkg>.<XxxGrpc>;` statement, which is always present (without it
  // the Java code wouldn't even compile). The package from the import
  // is exactly the proto package, so the contract id matches the
  // provider's verbatim — no `.proto` lookup needed.
  describe('Java client-jar consumer (import-derived FQN)', () => {
    it('test_consumer_with_import_emits_fqn_contract_id_without_local_proto', async () => {
      // No .proto file in this repo — the consumer ONLY has the import.
      writeFile(
        'src/main/java/AuthClient.java',
        `package my.app;

import io.grpc.ManagedChannel;
import com.acme.auth.proto.AuthServiceGrpc;

public class AuthClient {
    private final AuthServiceGrpc.AuthServiceBlockingStub stub;
    public AuthClient(ManagedChannel ch) {
        this.stub = AuthServiceGrpc.newBlockingStub(ch);
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('grpc::com.acme.auth.proto.AuthService/*');
      // Confidence stays at the "with proto" tier: the import
      // statement is at least as authoritative as a per-repo proto
      // map, so consumers shouldn't be penalised for not carrying
      // a redundant `.proto` file.
      expect(consumers[0].confidence).toBe(0.75);
      expect(consumers[0].meta.protoPackageSource).toBe('import');
      expect(consumers[0].meta.package).toBe('com.acme.auth.proto');
    });

    it('test_provider_with_import_emits_fqn_contract_id_without_local_proto', async () => {
      // Same idea on the provider side: a server impl class lives in
      // a repo that does NOT carry the originating `.proto`. The
      // import on `AuthServiceGrpc` is enough to derive the FQN.
      writeFile(
        'src/main/java/AuthServerImpl.java',
        `package my.server;

import com.acme.auth.proto.AuthServiceGrpc;
import io.grpc.stub.StreamObserver;

public class AuthServerImpl extends AuthServiceGrpc.AuthServiceImplBase {
    @Override
    public void login(LoginRequest req, StreamObserver<LoginResponse> obs) {}
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(1);
      expect(providers[0].contractId).toBe('grpc::com.acme.auth.proto.AuthService/*');
      expect(providers[0].confidence).toBe(0.8);
      expect(providers[0].meta.protoPackageSource).toBe('import');
    });

    it('test_same_short_name_different_packages_resolves_to_distinct_fqns', async () => {
      // The motivating real-world case (unipus_cloud_framework):
      // `ContentRpcService` is defined in TWO different proto packages
      // by two different client modules.
      //
      //   ucf-api-client/Service.proto    → cn.unipus.ucf.api.proto.client.service.ContentRpcService
      //   ucf-admin-client/Service.proto  → cn.unipus.ucf.admin.proto.client.service.ContentRpcService
      //
      // A short-name fallback would silently merge consumers of the
      // two services into one bogus contract id; the import-derived
      // FQN keeps them distinct.
      writeFile(
        'src/main/java/ApiContentClient.java',
        `package my.app.api;

import io.grpc.ManagedChannel;
import cn.unipus.ucf.api.proto.client.service.ContentRpcServiceGrpc;

public class ApiContentClient {
    private final ContentRpcServiceGrpc.ContentRpcServiceBlockingStub stub;
    public ApiContentClient(ManagedChannel ch) {
        this.stub = ContentRpcServiceGrpc.newBlockingStub(ch);
    }
}`,
      );
      writeFile(
        'src/main/java/AdminContentClient.java',
        `package my.app.admin;

import io.grpc.ManagedChannel;
import cn.unipus.ucf.admin.proto.client.service.ContentRpcServiceGrpc;

public class AdminContentClient {
    private final ContentRpcServiceGrpc.ContentRpcServiceBlockingStub stub;
    public AdminContentClient(ManagedChannel ch) {
        this.stub = ContentRpcServiceGrpc.newBlockingStub(ch);
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(2);
      const ids = consumers.map((c) => c.contractId).sort();
      expect(ids).toEqual([
        'grpc::cn.unipus.ucf.admin.proto.client.service.ContentRpcService/*',
        'grpc::cn.unipus.ucf.api.proto.client.service.ContentRpcService/*',
      ]);
    });

    it('test_local_proto_overrides_unrelated_import_with_same_short_name', async () => {
      // Symmetric to Finding 2: when the consumer repo carries its
      // OWN `.proto` defining the same short service name, the proto
      // is authoritative and wins over a Java import that points at a
      // different package. Without this Step-2 cross-check, a typo'd
      // or stale Java import (or genuinely unrelated same-name
      // service in the same repo) would silently corrupt the
      // contract id of the locally-defined service.
      writeFile(
        'protos/local-other.proto',
        `syntax = "proto3";
package local.unrelated;

service AuthService {
    rpc Ping (PingRequest) returns (PingResponse);
}`,
      );
      writeFile(
        'src/main/java/AuthClient.java',
        `package my.app;

import io.grpc.ManagedChannel;
import com.acme.auth.proto.AuthServiceGrpc;

public class AuthClient {
    private final AuthServiceGrpc.AuthServiceBlockingStub stub;
    public AuthClient(ManagedChannel ch) {
        this.stub = AuthServiceGrpc.newBlockingStub(ch);
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      // Local proto wins. The disagreement is recorded so operators
      // can investigate the divergent import.
      expect(consumers[0].contractId).toBe('grpc::local.unrelated.AuthService/*');
      expect(consumers[0].meta.protoPackageSource).toBe('proto-override');
      expect(consumers[0].meta.importPackage).toBe('com.acme.auth.proto');
    });

    it('test_consumer_without_import_falls_back_to_proto_map', async () => {
      // No import line — perhaps a fully-qualified call site like
      // `com.acme.auth.proto.AuthServiceGrpc.newBlockingStub(...)`,
      // or a refactor that broke the import. The current STUB_PATTERNS
      // captures only `(identifier) @grpc_cls`, so it skips the
      // fully-qualified form. With no detection there's also nothing
      // for the proto-map fallback to anchor onto. We assert the
      // benign no-op (no false-positive emitted) — the proto-map
      // fallback path is exercised by the dedicated test below.
      writeFile(
        'src/main/java/AuthClient.java',
        `package my.app;

import io.grpc.ManagedChannel;

public class AuthClient {
    private final com.acme.auth.proto.AuthServiceGrpc.AuthServiceBlockingStub stub;
    public AuthClient(ManagedChannel ch) {
        this.stub = com.acme.auth.proto.AuthServiceGrpc.newBlockingStub(ch);
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // STUB_PATTERNS only captures bare-identifier `XxxGrpc`, so the
      // fully-qualified `com.acme.auth.proto.AuthServiceGrpc.newStub(...)`
      // form is intentionally not matched. Pinning behaviour so the
      // import-driven path doesn't accidentally introduce a regression.
      expect(consumers).toHaveLength(0);
    });

    it('test_short_import_consumer_with_local_proto_still_uses_proto_map', async () => {
      // Backward-compat: when the consumer repo HAS a matching
      // `.proto` (the legacy path) AND the import is present, both
      // paths agree — but we want to confirm the import-driven path
      // takes precedence and emits the same FQN with the
      // `protoPackageSource: 'import'` marker.
      writeFile(
        'protos/auth.proto',
        `syntax = "proto3";
package com.acme.auth.proto;

service AuthService {
    rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );
      writeFile(
        'src/main/java/AuthClient.java',
        `package my.app;

import io.grpc.ManagedChannel;
import com.acme.auth.proto.AuthServiceGrpc;

public class AuthClient {
    private final AuthServiceGrpc.AuthServiceBlockingStub stub;
    public AuthClient(ManagedChannel ch) {
        this.stub = AuthServiceGrpc.newBlockingStub(ch);
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('grpc::com.acme.auth.proto.AuthService/*');
      // Marker confirms import path won, not the proto map. Both
      // would have produced the same FQN, but only the import path
      // is robust against client-jar consumers and same-short-name
      // collisions.
      expect(consumers[0].meta.protoPackageSource).toBe('import');
    });

    it('test_static_and_wildcard_imports_are_ignored', async () => {
      // `import static …` and `import w.x.*;` shouldn't pollute the
      // import map. Pinned via the tree-sitter query shape (the
      // `name:` field is only present on the non-static, non-wildcard
      // form). When the only `XxxGrpc` reference comes through one
      // of these unsupported import styles, the consumer detection
      // emits nothing-import-derived and the legacy short-name
      // fallback applies.
      writeFile(
        'src/main/java/AuthClient.java',
        `package my.app;

import static com.acme.auth.proto.Constants.SOMETHING;
import com.acme.unrelated.*;
import io.grpc.ManagedChannel;

public class AuthClient {
    private final com.acme.auth.proto.AuthServiceGrpc.AuthServiceBlockingStub stub;
    public AuthClient(ManagedChannel ch) {
        this.stub = com.acme.auth.proto.AuthServiceGrpc.newBlockingStub(ch);
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // STUB_PATTERNS doesn't match fully-qualified call forms; this
      // pins that adding GRPC_CLASS_IMPORT_PATTERNS doesn't accidentally
      // lift the static / wildcard imports into the FQN map (which
      // would have created a phantom detection).
      expect(consumers).toHaveLength(0);
    });

    it('test_provider_in_client_jar_consumer_repo_emits_provider_too', async () => {
      // Same repo holds a SERVER impl whose only knowledge of the
      // proto package is the import — no `.proto` is present. The
      // provider detection should also use the import-derived FQN.
      writeFile(
        'src/main/java/AuthServer.java',
        `package my.server;

import com.acme.auth.proto.AuthServiceGrpc;
import io.grpc.stub.StreamObserver;

@GrpcService
public class AuthServer extends AuthServiceGrpc.AuthServiceImplBase {
    @Override
    public void login(LoginRequest req, StreamObserver<LoginResponse> obs) {}
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(1);
      expect(providers[0].contractId).toBe('grpc::com.acme.auth.proto.AuthService/*');
      expect(providers[0].confidence).toBe(0.8);
      expect(providers[0].meta.protoPackageSource).toBe('import');
    });

    it('test_unipus_admin_and_api_consumers_in_one_repo_do_not_collide', async () => {
      // End-to-end version of the same-short-name case: a single
      // consumer repo imports BOTH `ContentRpcService` flavours from
      // unipus_cloud_framework. Ensures the per-file import map is
      // file-local (each file's import wins for that file's call sites)
      // rather than blurring across the whole repo.
      writeFile(
        'src/main/java/api/ApiContentClient.java',
        `package my.app.api;

import io.grpc.ManagedChannel;
import cn.unipus.ucf.api.proto.client.service.ContentRpcServiceGrpc;

public class ApiContentClient {
    public ApiContentClient(ManagedChannel ch) {
        ContentRpcServiceGrpc.newBlockingStub(ch);
    }
}`,
      );
      writeFile(
        'src/main/java/admin/AdminContentClient.java',
        `package my.app.admin;

import io.grpc.ManagedChannel;
import cn.unipus.ucf.admin.proto.client.service.ContentRpcServiceGrpc;

public class AdminContentClient {
    public AdminContentClient(ManagedChannel ch) {
        ContentRpcServiceGrpc.newBlockingStub(ch);
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(2);
      const ids = new Set(consumers.map((c) => c.contractId));
      expect(ids.has('grpc::cn.unipus.ucf.api.proto.client.service.ContentRpcService/*')).toBe(
        true,
      );
      expect(ids.has('grpc::cn.unipus.ucf.admin.proto.client.service.ContentRpcService/*')).toBe(
        true,
      );
    });
  });

  // ─── Java `option java_package` divergence ────────────────────
  // Java protobuf projects frequently set
  // `option java_package = "..."` to publish their generated Java
  // classes under a namespace different from the proto `package`
  // declaration. Google Cloud Java SDKs are the canonical example:
  // proto `package google.cloud.speech.v1` + `option java_package =
  // "com.google.cloud.speech.v1"`. Without specific handling, the
  // import-derived FQN would reflect the Java namespace instead of
  // the wire-protocol namespace and never match a provider's
  // contract id.
  //
  // The cases below pin the four resolution branches in
  // `detectionToContract`:
  //
  //   1. java_package translation (same-repo provider with the
  //      option set; consumer in the same repo imports via the
  //      java_package — the reverse index translates back to the
  //      proto package);
  //   2. proto-map cross-check (local proto exists for the same
  //      service short name and AGREES with the import — both paths
  //      produce the same FQN, marker confirms import path took
  //      precedence);
  //   2b. proto-map cross-check (local proto DISAGREES with the
  //       import — the proto wins authoritatively, the import package
  //       is recorded as `meta.importPackage` for diagnostics);
  //   3. import-derived fallback known limitation (consumer repo
  //      carries no proto AND the published proto sets a divergent
  //      java_package — we cannot translate without the proto in
  //      reach, so the FQN reflects the Java namespace and will not
  //      match a provider repo. This is documented as a scope
  //      limitation; the test pins the limitation to catch any
  //      accidental change in behaviour).
  describe('Java option java_package divergence', () => {
    it('test_provider_proto_with_diverging_java_package_emits_proto_package_FQN', async () => {
      // Provider side: proto declares both `package` and a
      // different `option java_package`. The provider contract id
      // must use the proto `package` — that's the wire identity any
      // consumer (regardless of its language) will see at runtime.
      writeFile(
        'proto/speech.proto',
        `syntax = "proto3";
package google.cloud.speech.v1;
option java_package = "com.google.cloud.speech.v1";
service Speech {
    rpc Recognize (RecognizeRequest) returns (RecognizeResponse);
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const recognize = providers.find((c) => c.contractId.endsWith('Speech/Recognize'));
      expect(recognize).toBeDefined();
      // Wire-protocol package, NOT the java_package value.
      expect(recognize!.contractId).toBe('grpc::google.cloud.speech.v1.Speech/Recognize');
    });

    it('test_consumer_with_java_package_translation_uses_proto_package', async () => {
      // Same repo carries the proto with a divergent java_package
      // AND a Java consumer that imports via the java_package. The
      // reverse index built by `buildProtoContext` should translate
      // the import back to the proto package so the consumer's
      // contract id matches the provider's.
      writeFile(
        'proto/speech.proto',
        `syntax = "proto3";
package google.cloud.speech.v1;
option java_package = "com.google.cloud.speech.v1";
service Speech {
    rpc Recognize (RecognizeRequest) returns (RecognizeResponse);
}`,
      );
      writeFile(
        'src/main/java/SpeechClient.java',
        `package my.app;

import io.grpc.ManagedChannel;
import com.google.cloud.speech.v1.SpeechGrpc;

public class SpeechClient {
    public SpeechClient(ManagedChannel ch) {
        SpeechGrpc.newBlockingStub(ch).recognize(null);
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      // The reverse-index translation kicked in:
      //   import     "com.google.cloud.speech.v1"
      //              ↓ (javaPackageMap lookup)
      //   proto pkg  "google.cloud.speech.v1"   ← used in contract id
      expect(consumers[0].contractId).toBe('grpc::google.cloud.speech.v1.Speech/*');
      expect(consumers[0].meta.protoPackageSource).toBe('import-translated');
      expect(consumers[0].meta.package).toBe('google.cloud.speech.v1');
    });

    it('test_consumer_without_local_proto_and_diverging_java_package_is_known_limitation', async () => {
      // Client-jar consumer: zero `.proto` in this repo, and the
      // published proto (somewhere else) uses a divergent
      // java_package. We have no way to translate from
      // java_package back to proto package without sight of the
      // source proto. The current behaviour is to use the
      // import-derived java_package literally; the resulting
      // contract id will not match a provider's. This is a
      // documented scope limitation — resolving it requires
      // group-level proto knowledge that's out of scope for this
      // change. The test pins the limitation so it cannot
      // regress silently.
      writeFile(
        'src/main/java/SpeechClient.java',
        `package my.app;

import io.grpc.ManagedChannel;
import com.google.cloud.speech.v1.SpeechGrpc;

public class SpeechClient {
    public SpeechClient(ManagedChannel ch) {
        SpeechGrpc.newBlockingStub(ch).recognize(null);
    }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      // Pinned limitation: the FQN reflects the Java namespace.
      expect(consumers[0].contractId).toBe('grpc::com.google.cloud.speech.v1.Speech/*');
      expect(consumers[0].meta.protoPackageSource).toBe('import');
    });
  });

  // ─── End-to-end wildcard match (Finding 3) ────────────────────
  // The 9 unit tests above pin contract-id shape; this block pins
  // the next stage of the pipeline — `runWildcardMatch` against a
  // provider index — so a regression in either contract-id format
  // OR in the matcher's wildcard logic would fail here. Per DoD §2.7
  // ("tests cover the real changed path"), exercising the pipeline
  // end to end is the production-readiness signal we need.
  describe('Java client-jar consumer — end-to-end wildcard match', () => {
    it('test_e2e_client_jar_consumer_FQN_creates_wildcard_cross_link', async () => {
      // Two-repo group fixture, written into separate subdirectories
      // of tmpDir so the per-repo `extract()` can run isolated.
      const providerDir = path.join(tmpDir, 'provider-repo');
      const consumerDir = path.join(tmpDir, 'consumer-repo');
      fs.mkdirSync(path.join(providerDir, 'proto'), { recursive: true });
      fs.mkdirSync(path.join(consumerDir, 'src/main/java'), { recursive: true });

      fs.writeFileSync(
        path.join(providerDir, 'proto/auth.proto'),
        `syntax = "proto3";
package com.acme.auth.proto;
service AuthService {
    rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );
      // Consumer repo carries NO `.proto` — typical client-jar pattern.
      fs.writeFileSync(
        path.join(consumerDir, 'src/main/java/AuthClient.java'),
        `package my.app;

import io.grpc.ManagedChannel;
import com.acme.auth.proto.AuthServiceGrpc;

public class AuthClient {
    public AuthClient(ManagedChannel ch) {
        AuthServiceGrpc.newBlockingStub(ch).login(null);
    }
}`,
      );

      const providerExtracted = await extractor.extract(null, providerDir, makeRepo(providerDir));
      const consumerExtracted = await extractor.extract(null, consumerDir, makeRepo(consumerDir));

      // Stamp `repo` on the contracts so they look like StoredContract;
      // matching.ts skips same-repo cross-links by comparing this field.
      const stored = [
        ...providerExtracted.map((c) => ({ ...c, repo: 'provider' })),
        ...consumerExtracted.map((c) => ({ ...c, repo: 'consumer' })),
      ];

      const providerIndex = buildProviderIndex(stored);
      const consumerWildcards = stored.filter(
        (c) => c.role === 'consumer' && c.contractId.endsWith('/*'),
      );
      const result = runWildcardMatch(consumerWildcards, providerIndex);

      // The consumer's contract id is the package-qualified service
      // wildcard (`grpc::com.acme.auth.proto.AuthService/*`); the
      // provider emits a method-level id (`grpc::com.acme.auth.proto.
      // AuthService/Login`). The wildcard matcher pairs them and
      // produces exactly one cross-link.
      expect(result.matched).toHaveLength(1);
      const cross = result.matched[0];
      expect(cross.contractId).toBe('grpc::com.acme.auth.proto.AuthService/*');
      expect(cross.matchType).toBe('wildcard');
      expect(cross.from.repo).toBe('consumer');
      expect(cross.to.repo).toBe('provider');
    });
  });

  describe('Python detection', () => {
    it('test_extract_python_add_servicer_returns_provider', async () => {
      writeFile(
        'server.py',
        `import grpc
from proto import auth_pb2_grpc

def serve():
    server = grpc.server(futures.ThreadPoolExecutor())
    auth_pb2_grpc.add_AuthServiceServicer_to_server(AuthServicer(), server)
    server.start()`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers[0].contractId).toContain('AuthService');
      expect(providers[0].confidence).toBe(0.65);
    });

    it('test_extract_python_stub_returns_consumer', async () => {
      writeFile(
        'client.py',
        `import grpc
from proto import auth_pb2_grpc

channel = grpc.insecure_channel('localhost:50051')
stub = auth_pb2_grpc.AuthServiceStub(channel)`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.length).toBeGreaterThanOrEqual(1);
      expect(consumers[0].contractId).toContain('AuthService');
      expect(consumers[0].confidence).toBe(0.55);
    });
  });

  describe('TypeScript/Node detection', () => {
    it('test_extract_ts_grpc_method_decorator_returns_provider', async () => {
      writeFile(
        'src/auth.controller.ts',
        `import { GrpcMethod } from '@nestjs/microservices';

export class AuthController {
  @GrpcMethod('AuthService', 'Login')
  login(data: LoginRequest): LoginResponse {
    return {};
  }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(1);
      expect(providers[0].contractId).toContain('AuthService');
      expect(providers[0].contractId).toContain('Login');
      expect(providers[0].confidence).toBe(0.8);
    });

    it('test_extract_ts_grpc_client_decorator_returns_consumer', async () => {
      writeFile(
        'proto/auth.proto',
        `syntax = "proto3";
package auth.v1;
service AuthService {
  rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );
      writeFile(
        'src/auth.client.ts',
        `import { GrpcClient } from '@nestjs/microservices';
import type { AuthServiceClient } from './generated/auth';

export class AuthGateway {
  @GrpcClient({ package: 'auth.v1', protoPath: 'proto/auth.proto' })
  private readonly authClient!: AuthServiceClient;
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('grpc::auth.v1.AuthService/*');
    });

    it('test_extract_ts_getService_without_decorator_returns_consumer', async () => {
      writeFile(
        'proto/auth.proto',
        `syntax = "proto3";
package auth.v1;
service AuthService {
  rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );
      writeFile(
        'src/auth.client.ts',
        `import type { ClientGrpc } from '@nestjs/microservices';

export function createAuthClient(client: ClientGrpc) {
  return client.getService<AuthService>('AuthService');
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('grpc::auth.v1.AuthService/*');
    });

    it('test_extract_ts_generated_client_constructor_returns_consumer', async () => {
      writeFile(
        'proto/auth.proto',
        `syntax = "proto3";
package auth.v1;
service AuthService {
  rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );
      writeFile(
        'src/auth.client.ts',
        `import { credentials } from '@grpc/grpc-js';
import { AuthServiceClient } from './generated/auth';

export const authClient = new AuthServiceClient('localhost:50051', credentials.createInsecure());`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('grpc::auth.v1.AuthService/*');
    });

    it('test_extract_ts_non_service_client_constructor_is_ignored', async () => {
      writeFile(
        'proto/auth.proto',
        `syntax = "proto3";
package auth.v1;
service AuthService {
  rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );
      writeFile(
        'src/auth.client.ts',
        `import { AuthClient } from './generated/auth';

export const authClient = new AuthClient('localhost:50051');`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(0);
    });

    it('test_extract_ts_loadPackageDefinition_constructor_returns_consumer', async () => {
      writeFile(
        'proto/auth.proto',
        `syntax = "proto3";
package auth.v1;
service AuthService {
  rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );
      writeFile(
        'src/auth.client.ts',
        `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const definition = protoLoader.loadSync('proto/auth.proto');
const authProto = grpc.loadPackageDefinition(definition) as any;
export const authClient = new authProto.auth.v1.AuthService(
  'localhost:50051',
  grpc.credentials.createInsecure(),
);`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('grpc::auth.v1.AuthService/*');
    });

    it('test_extract_ts_qualified_ctor_without_loadPackageDefinition_is_ignored', async () => {
      // Regression: an unrelated `obj.method(...)` member call must not trip the
      // loadPackageDefinition gate. With no loadPackageDefinition call present, a
      // qualified `new pkg...Service(...)` constructor must NOT become a consumer.
      // Pre-fix, the gate's shared-capture `function: [...]` alternation matched
      // every member call, so this spuriously emitted an AuthService consumer.
      writeFile(
        'proto/auth.proto',
        `syntax = "proto3";
package auth.v1;
service AuthService {
  rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );
      writeFile(
        'src/auth.client.ts',
        `import * as grpc from '@grpc/grpc-js';

logger.info('starting up');
export const authClient = new authProto.auth.v1.AuthService(
  'localhost:50051',
  grpc.credentials.createInsecure(),
);`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(0);
    });

    it('test_extract_ts_duplicate_consumer_patterns_in_one_file_dedupes_deterministically', async () => {
      writeFile(
        'proto/auth.proto',
        `syntax = "proto3";
package auth.v1;
service AuthService {
  rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );
      writeFile(
        'src/auth.client.ts',
        `import * as grpc from '@grpc/grpc-js';
import type { ClientGrpc } from '@nestjs/microservices';
import { AuthServiceClient } from './generated/auth';

export class AuthGateway {
  constructor(private readonly client: ClientGrpc) {}

  connect() {
    this.client.getService<AuthService>('AuthService');
    return new AuthServiceClient('localhost:50051', grpc.credentials.createInsecure());
  }
}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('grpc::auth.v1.AuthService/*');
    });
  });

  describe('edge cases', () => {
    it('test_extract_empty_repo_returns_empty', async () => {
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts).toHaveLength(0);
    });

    it('test_extract_repo_without_grpc_returns_empty', async () => {
      writeFile('src/index.ts', 'console.log("hello")');
      writeFile('package.json', '{}');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts).toHaveLength(0);
    });
  });

  // ─── #1185: gRPC extractor must honour .gitnexusignore ──────────────
  //
  // Both the `.proto` glob (in `buildProtoContext`) and the source-scan
  // glob (in `extract`) used a hardcoded ignore array that bypassed
  // `IgnoreService`. Both globs now consume the shared filter (mirrors
  // `filesystem-walker.ts`) so any `.gitnexusignore` pattern is
  // honoured. The single test below exercises BOTH paths in the same
  // run: a `.proto` under `mentor_env/` (proto-context build) AND a
  // Python `_pb2_grpc.<Name>Stub` consumer under `mentor_env/`
  // (source-scan path) — neither produces a contract.
  describe('respects .gitnexusignore (#1185)', () => {
    it('proto + source globs both skip files matched by .gitnexusignore', async () => {
      // Control: a regular .proto in a non-ignored dir.
      writeFile(
        'proto/auth.proto',
        `syntax = "proto3";
package auth;
service AuthService {
  rpc Login (LoginRequest) returns (LoginResponse);
}`,
      );
      // Vendored proto under a venv-style dir — exercises proto-context glob.
      writeFile(
        'mentor_env/lib/leaked.proto',
        `syntax = "proto3";
package leaked;
service LeakedService {
  rpc Ping (PingRequest) returns (PingResponse);
}`,
      );
      // Vendored Python consumer under the same venv-style dir —
      // exercises the second glob in `extract()` (source-scan path).
      // Mirrors the canonical pattern from
      // `test_extract_python_stub_returns_consumer` above; without the
      // `.gitnexusignore` filter this WOULD emit a `grpc::*/LeakedService`
      // consumer contract.
      writeFile(
        'mentor_env/lib/leaked_consumer.py',
        `import grpc
from proto import leaked_pb2_grpc

channel = grpc.insecure_channel('localhost:50051')
stub = leaked_pb2_grpc.LeakedServiceStub(channel)`,
      );
      writeFile('.gitnexusignore', 'mentor_env/\n');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      // Control proto provider is still emitted.
      expect(contracts.find((c) => c.contractId === 'grpc::auth.AuthService/Login')).toBeDefined();
      // Defence-in-depth: no contract — provider OR consumer — has a
      // `symbolRef` path under the ignored directory. Catches both globs
      // at once.
      expect(contracts.some((c) => c.symbolRef?.filePath?.startsWith('mentor_env/'))).toBe(false);
      // Specific assertions per glob path.
      expect(
        contracts.find((c) => c.contractId === 'grpc::leaked.LeakedService/Ping'),
      ).toBeUndefined();
      expect(
        contracts.some((c) => c.role === 'consumer' && /LeakedService/.test(c.contractId)),
      ).toBe(false);
    });
  });

  describe('Windows SIGSEGV regression — large input must route through parseSourceSafe', () => {
    it('routes >32 767-char source file through parseSourceSafe (not direct parser.parse)', async () => {
      parseSourceSafeSpy.mockClear();

      // Synthesize a >40 000-char source file in a language whose grpc plugin
      // is always available (Go has no optional grammar — the Go plugin is
      // unconditionally wired in grpc-patterns/index.ts). Direct
      // parser.parse(content) on an input this size SIGSEGVs the process on
      // Windows; parseSourceSafe routes through the chunked-callback path and
      // works on every platform. The spy assertion is what catches the
      // regression — a "no throw" assertion alone is satisfied by the bypass
      // on Linux/macOS where parser.parse(40 000 chars) succeeds.
      const padding = Array.from(
        { length: 600 },
        (_, i) => `func helper${i}() string { return "padding-${i}-aaaaaaaaaaaaaaaaaaaaaa" }\n`,
      ).join('');
      const largeGo = `package big\n\n${padding}\n`;
      expect(largeGo.length).toBeGreaterThan(40_000);

      writeFile('server/big.go', largeGo);

      await extractor.extract(null, tmpDir, makeRepo(tmpDir));

      expect(parseSourceSafeSpy).toHaveBeenCalled();
    });
  });
});

describe('buildProtoMap', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'proto-test-'));
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('test_buildProtoMap_single_proto_parses_package_service_methods', async () => {
    const protoContent = `
syntax = "proto3";
package com.example;

service UserService {
  rpc GetUser (GetUserRequest) returns (GetUserResponse);
  rpc ListUsers (ListUsersRequest) returns (ListUsersResponse);
}`;
    await fsp.mkdir(path.join(tmpDir, 'proto'), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, 'proto', 'user.proto'), protoContent);

    const map = await buildProtoMap(tmpDir);
    expect(map.has('UserService')).toBe(true);
    const entries = map.get('UserService')!;
    expect(entries).toHaveLength(1);
    expect(entries[0].package).toBe('com.example');
    expect(entries[0].serviceName).toBe('UserService');
    expect(entries[0].methods).toEqual(['GetUser', 'ListUsers']);
    expect(entries[0].protoPath).toBe('proto/user.proto');
  });

  it('test_buildProtoMap_no_package_declaration', async () => {
    const protoContent = `
syntax = "proto3";
service Foo { rpc Bar (Req) returns (Res); }`;
    await fsp.writeFile(path.join(tmpDir, 'foo.proto'), protoContent);

    const map = await buildProtoMap(tmpDir);
    const entries = map.get('Foo')!;
    expect(entries[0].package).toBe('');
  });

  it('test_buildProtoMap_no_protos_returns_empty', async () => {
    const map = await buildProtoMap(tmpDir);
    expect(map.size).toBe(0);
  });

  it('test_buildProtoMap_conflicting_names', async () => {
    await fsp.mkdir(path.join(tmpDir, 'a'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, 'b'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'a', 'svc.proto'),
      'package pkg.a;\nservice Svc { rpc Do (R) returns (R); }',
    );
    await fsp.writeFile(
      path.join(tmpDir, 'b', 'svc.proto'),
      'package pkg.b;\nservice Svc { rpc Do (R) returns (R); }',
    );

    const map = await buildProtoMap(tmpDir);
    expect(map.get('Svc')).toHaveLength(2);
  });

  it('test_buildProtoMap_imported_package_is_inherited_for_split_service_definition', async () => {
    await fsp.mkdir(path.join(tmpDir, 'proto', 'shared'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, 'proto', 'services'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'proto', 'shared', 'package.proto'),
      'package auth.v1;\nmessage LoginRequest {}',
    );
    await fsp.writeFile(
      path.join(tmpDir, 'proto', 'services', 'auth.proto'),
      'import "../shared/package.proto";\nservice AuthService { rpc Login (LoginRequest) returns (LoginRequest); }',
    );

    const map = await buildProtoMap(tmpDir);
    const entries = map.get('AuthService')!;

    expect(entries).toHaveLength(1);
    expect(entries[0].package).toBe('auth.v1');
  });
});

describe('resolveProtoConflict', () => {
  const makeInfo = (pkg: string, protoPath: string): ProtoServiceInfo => ({
    package: pkg,
    serviceName: 'Svc',
    methods: ['Do'],
    protoPath,
  });

  it('test_single_candidate_returns_it', () => {
    const result = resolveProtoConflict('Svc', 'src/main.go', [makeInfo('pkg', 'proto/svc.proto')]);
    expect(result?.package).toBe('pkg');
  });

  it('test_multiple_candidates_picks_closest_directory', () => {
    const candidates = [
      makeInfo('far', 'other/dir/svc.proto'),
      makeInfo('close', 'src/proto/svc.proto'),
    ];
    const result = resolveProtoConflict('Svc', 'src/server.go', candidates);
    expect(result?.package).toBe('close');
  });

  it('test_centralized_proto_layout_prefers_shared_path_segments_over_prefix_only', () => {
    const candidates = [
      makeInfo('billing', 'proto/services/billing/svc.proto'),
      makeInfo('auth', 'proto/services/auth/svc.proto'),
    ];
    const result = resolveProtoConflict('Svc', 'services/auth/src/server.ts', candidates);
    expect(result?.package).toBe('auth');
  });

  it('test_no_candidates_returns_null', () => {
    expect(resolveProtoConflict('Svc', 'src/main.go', [])).toBeNull();
  });

  it('test_all_zero_tie_returns_null', () => {
    const cap = _captureLogger();
    const candidates = [
      makeInfo('pkgA', 'totally/unrelated/a/svc.proto'),
      makeInfo('pkgB', 'completely/different/b/svc.proto'),
    ];
    const result = resolveProtoConflict('Svc', 'src/main.go', candidates);
    expect(result).toBeNull();
    cap.restore();
  });

  it('test_positive_score_tie_returns_null', () => {
    const cap = _captureLogger();
    // Both candidates share `src/proto` with the source dir — equal shared runs.
    const candidates = [
      makeInfo('pkgA', 'src/proto/a/svc.proto'),
      makeInfo('pkgB', 'src/proto/b/svc.proto'),
    ];
    const result = resolveProtoConflict('Svc', 'src/proto/main.go', candidates);
    expect(result).toBeNull();
    cap.restore();
  });

  it('test_three_way_zero_tie_returns_null', () => {
    const cap = _captureLogger();
    const candidates = [
      makeInfo('pkgA', 'aaa/svc.proto'),
      makeInfo('pkgB', 'bbb/svc.proto'),
      makeInfo('pkgC', 'ccc/svc.proto'),
    ];
    const result = resolveProtoConflict('Svc', 'src/main.go', candidates);
    expect(result).toBeNull();
    cap.restore();
  });

  it('test_unique_winner_among_ties', () => {
    // Winner with shared run 2 (services/auth), two losers with score 0.
    const candidates = [
      makeInfo('winner', 'services/auth/proto/svc.proto'),
      makeInfo('loserA', 'totally/unrelated/a/svc.proto'),
      makeInfo('loserB', 'elsewhere/b/svc.proto'),
    ];
    const result = resolveProtoConflict('Svc', 'services/auth/src/server.ts', candidates);
    expect(result?.package).toBe('winner');
  });

  it('test_ambiguous_emits_single_warn_with_service_and_paths', () => {
    const cap = _captureLogger();
    const candidates = [
      makeInfo('pkgA', 'totally/unrelated/a/svc.proto'),
      makeInfo('pkgB', 'completely/different/b/svc.proto'),
    ];
    resolveProtoConflict('MyService', 'src/main.go', candidates);
    expect(cap.records().length).toBe(1);
    const msg = String(String(cap.records()[0]?.msg ?? ''));
    expect(msg).toContain('MyService');
    expect(msg).toContain('src/main.go');
    expect(msg).toContain('totally/unrelated/a/svc.proto');
    expect(msg).toContain('completely/different/b/svc.proto');
    cap.restore();
  });
});

describe('GrpcExtractor.extract ambiguous proto resolution', () => {
  let tmpDir: string;
  let extractor: GrpcExtractor;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-grpc-ambig-'));
    extractor = new GrpcExtractor();
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: '',
    repoPath,
    storagePath: '',
  });

  it('test_ambiguous_short_name_across_unrelated_protos_yields_no_source_contract', async () => {
    const cap = _captureLogger();
    // Two unrelated proto files defining the same short name `UserService` in
    // unrelated directories, neither sharing path segments with the Go source.
    await fsp.mkdir(path.join(tmpDir, 'billing-team', 'proto'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'billing-team', 'proto', 'user.proto'),
      'package billing.v1;\nservice UserService { rpc GetUser (R) returns (R); }',
    );
    await fsp.mkdir(path.join(tmpDir, 'auth-team', 'proto'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'auth-team', 'proto', 'user.proto'),
      'package auth.v1;\nservice UserService { rpc GetUser (R) returns (R); }',
    );
    // Consumer in an unrelated directory.
    await fsp.mkdir(path.join(tmpDir, 'apps', 'gateway'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'apps', 'gateway', 'client.go'),
      'package main\nfunc init() { client := pb.NewUserServiceClient(conn) }',
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    // No source-attributed contract for UserService should be emitted.
    const sourceContracts = contracts.filter(
      (c) => c.meta.source === 'go_client' && c.meta.service === 'UserService',
    );
    expect(sourceContracts).toHaveLength(0);
    expect(cap.records().length).toBeGreaterThan(0);
    cap.restore();
  });
});

describe('serviceContractId', () => {
  it('test_with_package', () => {
    expect(serviceContractId('com.example', 'UserService')).toBe('grpc::com.example.UserService/*');
  });

  it('test_without_package', () => {
    expect(serviceContractId('', 'UserService')).toBe('grpc::UserService/*');
  });
});

describe('proto-aware source scanners', () => {
  let tmpDir: string;
  let extractor: GrpcExtractor;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scanner-test-'));
    extractor = new GrpcExtractor();
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: '',
    repoPath,
    storagePath: '',
  });

  it('test_go_provider_with_proto_uses_canonical_service_id', async () => {
    await fsp.mkdir(path.join(tmpDir, 'proto'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'proto', 'user.proto'),
      'package com.example;\nservice UserService { rpc GetUser (R) returns (R); }',
    );
    await fsp.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'src', 'server.go'),
      'package main\nfunc init() { pb.RegisterUserServiceServer(srv, &impl{}) }',
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    const goProvider = contracts.find((c) => c.meta.source === 'go_register');
    expect(goProvider).toBeDefined();
    expect(goProvider!.contractId).toBe('grpc::com.example.UserService/*');
    expect(goProvider!.confidence).toBe(0.8);
  });

  it('test_go_provider_without_proto_reduced_confidence', async () => {
    await fsp.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'src', 'server.go'),
      'package main\nfunc init() { pb.RegisterFooServer(srv, &impl{}) }',
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    const goProvider = contracts.find((c) => c.meta.source === 'go_register');
    expect(goProvider).toBeDefined();
    expect(goProvider!.contractId).toBe('grpc::Foo/*');
    expect(goProvider!.confidence).toBe(0.65);
  });

  it('test_go_consumer_with_proto_uses_canonical_service_id', async () => {
    await fsp.mkdir(path.join(tmpDir, 'proto'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'proto', 'user.proto'),
      'package com.example;\nservice UserService { rpc GetUser (R) returns (R); }',
    );
    await fsp.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'src', 'client.go'),
      'package main\nfunc init() { client := pb.NewUserServiceClient(conn) }',
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    const goConsumer = contracts.find((c) => c.meta.source === 'go_client');
    expect(goConsumer).toBeDefined();
    expect(goConsumer!.contractId).toBe('grpc::com.example.UserService/*');
    expect(goConsumer!.confidence).toBe(0.75);
  });

  it('test_java_provider_with_proto_uses_canonical_service_id', async () => {
    await fsp.mkdir(path.join(tmpDir, 'proto'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'proto', 'user.proto'),
      'package com.example;\nservice UserService { rpc GetUser (R) returns (R); }',
    );
    await fsp.mkdir(path.join(tmpDir, 'src', 'main', 'java'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'src', 'main', 'java', 'UserGrpcService.java'),
      `@GrpcService
public class UserGrpcService extends UserServiceGrpc.UserServiceImplBase {
    @Override
    public void getUser(GetUserRequest req, StreamObserver<GetUserResponse> obs) {}
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    const javaProvider = contracts.find((c) => c.meta.source === 'java_grpc_service');
    expect(javaProvider).toBeDefined();
    expect(javaProvider!.contractId).toBe('grpc::com.example.UserService/*');
    expect(javaProvider!.confidence).toBe(0.8);
  });

  it('test_python_consumer_with_proto_uses_canonical_service_id', async () => {
    await fsp.mkdir(path.join(tmpDir, 'proto'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'proto', 'user.proto'),
      'package com.example;\nservice UserService { rpc GetUser (R) returns (R); }',
    );
    await fsp.writeFile(
      path.join(tmpDir, 'client.py'),
      `import grpc
channel = grpc.insecure_channel('localhost:50051')
stub = UserServiceStub(channel)`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    const pyConsumer = contracts.find((c) => c.meta.source === 'python_stub');
    expect(pyConsumer).toBeDefined();
    expect(pyConsumer!.contractId).toBe('grpc::com.example.UserService/*');
    expect(pyConsumer!.confidence).toBe(0.75);
  });

  it('test_ts_provider_with_proto_adds_package', async () => {
    await fsp.mkdir(path.join(tmpDir, 'proto'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'proto', 'user.proto'),
      'package com.example;\nservice UserService { rpc GetUser (R) returns (R); }',
    );
    await fsp.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'src', 'controller.ts'),
      "@GrpcMethod('UserService', 'GetUser')\nasync getUser() {}",
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    const tsProvider = contracts.find((c) => c.meta.source === 'ts_grpc_method');
    expect(tsProvider).toBeDefined();
    expect(tsProvider!.contractId).toBe('grpc::com.example.UserService/GetUser');
    expect(tsProvider!.confidence).toBe(0.8);
  });

  it('test_proto_provider_inherits_package_from_imported_definition', async () => {
    await fsp.mkdir(path.join(tmpDir, 'proto', 'shared'), { recursive: true });
    await fsp.mkdir(path.join(tmpDir, 'proto', 'services'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'proto', 'shared', 'package.proto'),
      'package auth.v1;\nmessage LoginRequest {}',
    );
    await fsp.writeFile(
      path.join(tmpDir, 'proto', 'services', 'auth.proto'),
      `syntax = "proto3";
import "../shared/package.proto";
service AuthService {
  rpc Login (LoginRequest) returns (LoginRequest);
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    const protoProvider = contracts.find(
      (c) => c.symbolRef.filePath === 'proto/services/auth.proto',
    );
    expect(protoProvider).toBeDefined();
    expect(protoProvider!.contractId).toBe('grpc::auth.v1.AuthService/Login');
  });
});
