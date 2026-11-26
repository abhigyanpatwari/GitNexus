import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import Parser from 'tree-sitter';
import {
  PROTO_GRPC_PLUGIN,
  extractPackageFromTree,
} from '../../../src/core/group/extractors/grpc-patterns/proto.js';

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
    it('loads the native proto grammar and preserves syntax fields and service queries', () => {
      expect(PROTO_GRPC_PLUGIN).not.toBeNull();
      if (!PROTO_GRPC_PLUGIN) throw new Error('Vendored Protobuf grammar failed to initialize');
      const plugin = PROTO_GRPC_PLUGIN;
      const parser = new Parser();
      parser.setLanguage(plugin.language);
      const tree = parser.parse(`syntax = "proto3";
package native.v1;
service NativeService {
  // rpc Removed (Request) returns (Response);
  rpc Active (Request) returns (Response);
}`);

      expect(tree.rootNode.hasError).toBe(false);
      const syntax = tree.rootNode.namedChildren.find((node) => node.type === 'syntax');
      expect(syntax?.childForFieldName('version')?.text).toBe('"proto3"');
      expect(extractPackageFromTree(tree)).toBe('native.v1');
      expect(plugin.scan(tree).map((detection) => detection.symbolName)).toEqual([
        'NativeService.Active',
      ]);
    });

    it('excludes RPC declarations in comments and strings from the fallback map and contracts', async () => {
      writeFile(
        'api/commented-rpc.proto',
        `syntax = "proto3";
package commented;
service Svc {
  // rpc LineComment (Req) returns (Res);
  /* rpc BlockComment (Req) returns (Res); */
  option (description) = "rpc StringLiteral (Req) returns (Res);";
  rpc Active (Req) returns (Res);
}`,
      );

      // buildProtoMap always uses the manual parser, even when the native
      // grammar is available. Assert it independently of plugin selection.
      const services = await buildProtoMap(tmpDir);
      expect(services.get('Svc')?.map((service) => service.methods)).toEqual([['Active']]);
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts.map((contract) => contract.symbolName)).toEqual(['Svc.Active']);
    });

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

    it('keeps same-named services from sibling protos in different packages', async () => {
      writeFile('api/a.proto', 'package a;\nservice Svc { rpc Get (R) returns (R); }');
      writeFile('api/b.proto', 'package b;\nservice Svc { rpc Get (R) returns (R); }');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const ids = contracts
        .filter((c) => c.role === 'provider')
        .map((c) => `${c.symbolRef.filePath} ${c.contractId}`)
        .sort();

      expect(ids).toEqual(['api/a.proto grpc::a.Svc/Get', 'api/b.proto grpc::b.Svc/Get']);
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

    // #1186: test doubles are often named like stubs.
    it('test_extract_python_test_double_without_grpc_import_is_ignored', async () => {
      writeFile(
        'tests/services/test_session_rule_service_purge.py',
        `from app.services.session_rule_service import SessionRuleService


class _CollectionStub:
    def __init__(self):
        self.deleted = []

    def delete_many(self, query):
        self.deleted.append(query)


def test_purge_deletes_the_rules_of_a_session():
    collection = _CollectionStub()
    SessionRuleService(collection).purge("s1")
    assert collection.deleted == [{"session_id": "s1"}]`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts.filter((c) => c.role === 'consumer')).toHaveLength(0);
    });

    it('test_extract_python_imported_test_double_without_grpc_import_is_ignored', async () => {
      writeFile(
        'tests/services/test_session_service.py',
        `from tests.fakes import SessionRepoStub
from app.services.session_service import SessionService


def test_close_marks_the_session_closed():
    repo = SessionRepoStub()
    SessionService(repo).close("s1")
    assert repo.closed == ["s1"]`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts.filter((c) => c.role === 'consumer')).toHaveLength(0);
    });

    it.each([
      [
        'called through self',
        `import grpc


class TestAuthClient:
    class _RepoStub:
        pass

    def test_login(self):
        return self._RepoStub()`,
      ],
      [
        'that extends a generated stub under another name',
        `from proto import auth_pb2_grpc


class FakeAuthStub(auth_pb2_grpc.AuthServiceStub):
    def Login(self, request, timeout=None):
        return None


def test_login(channel):
    return FakeAuthStub(channel)`,
      ],
      [
        'that extends a class of the same name outside gRPC',
        `import grpc

from tests import fakes


class AuthServiceStub(fakes.AuthServiceStub):
    pass


def test_login():
    return AuthServiceStub()`,
      ],
      [
        'that extends a stub-named class that is not generated',
        `import grpc

from tests.fakes import BaseRepoStub


class _AuthServiceStub(BaseRepoStub):
    pass


def test_login():
    return _AuthServiceStub()`,
      ],
    ])(
      'test_extract_python_test_double_in_a_grpc_file_is_ignored when %s',
      async (_form, source) => {
        writeFile('tests/test_client.py', source);

        const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
        expect(contracts.filter((c) => c.role === 'consumer')).toHaveLength(0);
      },
    );

    // The trade-off #1186 accepts: a betterproto package has no gRPC part in
    // its name, so a file that only imports its stub is not detected.
    it('test_extract_python_stub_without_any_grpc_import_is_not_detected', async () => {
      writeFile(
        'app/greeter.py',
        `from .lib.helloworld import GreeterStub


def greeter(channel):
    return GreeterStub(channel)`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts.filter((c) => c.role === 'consumer')).toHaveLength(0);
    });

    it('test_extract_python_stub_class_defined_in_a_grpc_file_is_ignored', async () => {
      writeFile(
        'tests/clients/test_auth_client.py',
        `import grpc

from app.clients.auth import AuthClient


class _AuthServiceStub:
    def Login(self, request, timeout=None):
        raise grpc.RpcError()


def test_login_maps_rpc_errors():
    client = AuthClient(stub=_AuthServiceStub())
    assert client.login("u", "p") is None`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(contracts.filter((c) => c.role === 'consumer')).toHaveLength(0);
    });

    it.each([
      [
        'a stub imported from its generated module, with the channel passed in',
        `from proto.orders_pb2_grpc import OrderServiceStub


class OrdersClient:
    def __init__(self, channel):
        self.stub = OrderServiceStub(channel)`,
        'grpc::OrderService/*',
      ],
      [
        'an aliased generated module',
        `import proto.billing_pb2_grpc as rpc


def billing_client(channel):
    return rpc.BillingServiceStub(channel)`,
        'grpc::BillingService/*',
      ],
      [
        'grpc.aio and a relative import',
        `from grpc import aio

from . import search_pb2_grpc


async def search(query):
    async with aio.insecure_channel("search:50051") as channel:
        return await search_pb2_grpc.SearchServiceStub(channel).Search(query)`,
        'grpc::SearchService/*',
      ],
      [
        'a module generated for grpclib',
        `from .helloworld_grpc import GreeterStub


def greeter(channel):
    return GreeterStub(channel)`,
        'grpc::Greeter/*',
      ],
      [
        'betterproto and a grpclib channel',
        `from grpclib.client import Channel

from .lib.helloworld import GreeterStub


async def greet(name):
    async with Channel("greeter", 50051) as channel:
        return await GreeterStub(channel).say_hello(name=name)`,
        'grpc::Greeter/*',
      ],
      [
        'imports inside the function',
        `def users_client(target):
    import grpc
    from proto import users_pb2_grpc

    return users_pb2_grpc.UserServiceStub(grpc.insecure_channel(target))`,
        'grpc::UserService/*',
      ],
      [
        'a relative generated-module import alone',
        `from . import search_pb2_grpc


def client(channel):
    return search_pb2_grpc.SearchServiceStub(channel)`,
        'grpc::SearchService/*',
      ],
      [
        'a call through the generated module next to a class of the same name',
        `import proto.auth_pb2_grpc as rpc


class AuthServiceStub:
    pass


def client(channel):
    return rpc.AuthServiceStub(channel)`,
        'grpc::AuthService/*',
      ],
      [
        'a call through a dotted generated module next to a class of the same name',
        `import proto.auth_pb2_grpc


class AuthServiceStub:
    pass


def client(channel):
    return proto.auth_pb2_grpc.AuthServiceStub(channel)`,
        'grpc::AuthService/*',
      ],
      [
        'a facade of the same name over the generated stub',
        `import grpc
import auth_pb2_grpc


class AuthServiceStub:
    def __init__(self, channel):
        self._inner = auth_pb2_grpc.AuthServiceStub(channel)`,
        'grpc::AuthService/*',
      ],
      [
        'a subclass that keeps the generated name',
        `import grpc
from proto import users_pb2_grpc


class UserServiceStub(users_pb2_grpc.UserServiceStub):
    pass


def connect(target):
    return UserServiceStub(grpc.insecure_channel(target))`,
        'grpc::UserService/*',
      ],
    ])('test_extract_python_stub_returns_consumer with %s', async (_form, source, contractId) => {
      writeFile('app/client.py', source);

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.map((c) => c.contractId)).toEqual([contractId]);
    });
  });

  describe('edge cases', () => {
    it('test_extract_empty_repo_returns_empty', async () => {
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
    javaPackage: '',
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
