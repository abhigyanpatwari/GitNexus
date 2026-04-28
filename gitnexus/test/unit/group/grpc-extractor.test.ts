import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  GrpcExtractor,
  buildProtoMap,
  resolveProtoConflict,
  serviceContractId,
} from '../../../src/core/group/extractors/grpc-extractor.js';
import type { ProtoServiceInfo } from '../../../src/core/group/extractors/grpc-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const candidates = [
      makeInfo('pkgA', 'totally/unrelated/a/svc.proto'),
      makeInfo('pkgB', 'completely/different/b/svc.proto'),
    ];
    const result = resolveProtoConflict('Svc', 'src/main.go', candidates);
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });

  it('test_positive_score_tie_returns_null', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Both candidates share `src/proto` with the source dir — equal shared runs.
    const candidates = [
      makeInfo('pkgA', 'src/proto/a/svc.proto'),
      makeInfo('pkgB', 'src/proto/b/svc.proto'),
    ];
    const result = resolveProtoConflict('Svc', 'src/proto/main.go', candidates);
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });

  it('test_three_way_zero_tie_returns_null', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const candidates = [
      makeInfo('pkgA', 'aaa/svc.proto'),
      makeInfo('pkgB', 'bbb/svc.proto'),
      makeInfo('pkgC', 'ccc/svc.proto'),
    ];
    const result = resolveProtoConflict('Svc', 'src/main.go', candidates);
    expect(result).toBeNull();
    warnSpy.mockRestore();
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const candidates = [
      makeInfo('pkgA', 'totally/unrelated/a/svc.proto'),
      makeInfo('pkgB', 'completely/different/b/svc.proto'),
    ];
    resolveProtoConflict('MyService', 'src/main.go', candidates);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain('MyService');
    expect(msg).toContain('src/main.go');
    expect(msg).toContain('totally/unrelated/a/svc.proto');
    expect(msg).toContain('completely/different/b/svc.proto');
    warnSpy.mockRestore();
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
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
