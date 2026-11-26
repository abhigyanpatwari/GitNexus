import { afterEach, beforeEach, describe, it } from 'node:test';
import { expect } from 'expect';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { GrpcExtractor } from '../../../../src/core/group/extractors/grpc-extractor.js';
import type { RepoHandle } from '../../../../src/core/group/types.js';
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

  it('test_extract_repo_without_grpc_returns_empty', async () => {
    writeFile('src/index.ts', 'console.log("hello")');
    writeFile('package.json', '{}');

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    expect(contracts).toHaveLength(0);
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
});
