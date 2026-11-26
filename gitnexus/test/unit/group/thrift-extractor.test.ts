import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  ThriftExtractor,
  buildThriftContext,
  thriftMethodContractId,
  thriftServiceContractId,
} from '../../../src/core/group/extractors/thrift-extractor.js';
import { serviceFromAnnotatedClient } from '../../../src/core/group/extractors/thrift-patterns/java.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

describe('ThriftExtractor', () => {
  let tmpDir: string;
  let extractor: ThriftExtractor;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-thrift-'));
    extractor = new ThriftExtractor();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
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

  it('test_extract_thrift_single_method_returns_idl_provider', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
      type: 'thrift',
      role: 'provider',
      symbolName: 'OrderService.PlaceOrder',
      confidence: 0.85,
      meta: {
        namespace: 'billing.v1',
        service: 'OrderService',
        method: 'PlaceOrder',
        source: 'thrift_idl',
      },
    });
    expect(contracts[0].symbolRef).toEqual({
      filePath: 'idl/order.thrift',
      name: 'OrderService.PlaceOrder',
    });
  });

  it('test_extract_thrift_multiple_services_and_methods_returns_all', async () => {
    writeFile(
      'contracts/orders.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
  OrderStatus GetOrderStatus(1: string orderId)
}

service InvoiceService {
  Invoice CreateInvoice(1: string orderId)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    expect(contracts.map((c) => c.contractId).sort()).toEqual([
      'thrift::billing.v1.InvoiceService/CreateInvoice',
      'thrift::billing.v1.OrderService/GetOrderStatus',
      'thrift::billing.v1.OrderService/PlaceOrder',
    ]);
  });

  it('test_extract_thrift_prefers_java_namespace_over_other_namespaces', async () => {
    writeFile(
      'order.thrift',
      `namespace py billing_python.v1
namespace java billing.v1
namespace go billinggo

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    expect(contracts[0].contractId).toBe('thrift::billing.v1.OrderService/PlaceOrder');
    expect(contracts[0].meta.namespace).toBe('billing.v1');
  });

  it('test_extract_thrift_uses_first_non_java_namespace_when_java_missing', async () => {
    writeFile(
      'order.thrift',
      `namespace py billing_python.v1
namespace go billinggo

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    expect(contracts[0].contractId).toBe('thrift::billing_python.v1.OrderService/PlaceOrder');
    expect(contracts[0].meta.namespace).toBe('billing_python.v1');
  });

  it('test_extract_thrift_without_namespace_uses_service_only', async () => {
    writeFile(
      'order.thrift',
      `service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    expect(contracts[0].contractId).toBe('thrift::OrderService/PlaceOrder');
    expect(contracts[0].meta.namespace).toBe('');
  });

  it('test_extract_thrift_ignores_braces_inside_comments_and_strings', async () => {
    writeFile(
      'idl/tricky.thrift',
      `namespace java billing.v1

service OrderService {
  // A comment with } should not close the service.
  /* A block comment with { and } should not affect depth. */
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
  const string NOTE = "literal with } and { braces"
  OrderStatus GetOrderStatus(1: string orderId)
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    expect(contracts.map((c) => c.symbolName).sort()).toEqual([
      'OrderService.GetOrderStatus',
      'OrderService.PlaceOrder',
    ]);
  });

  it('test_extract_thrift_malformed_unclosed_service_is_skipped', async () => {
    writeFile(
      'idl/broken.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
`,
    );

    await expect(extractor.extract(null, tmpDir, makeRepo(tmpDir))).resolves.toEqual([]);
  });

  it('test_extract_repo_without_thrift_returns_empty', async () => {
    writeFile('src/index.ts', 'console.log("hello")');

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    expect(contracts).toEqual([]);
  });

  // ─── #1156-followup: thrift extractor must honour .gitnexusignore ────
  //
  // Both the `.thrift` IDL glob (in `buildThriftContext`) and the
  // source-scan glob (in `extract`) used a hardcoded ignore array that
  // bypassed `IgnoreService`. Both globs now consume the shared filter
  // so any `.gitnexusignore` pattern is honoured.
  describe('respects .gitnexusignore (#1156-followup)', () => {
    it('thrift IDL glob skips files matched by .gitnexusignore', async () => {
      writeFile(
        'idl/order.thrift',
        `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
      );
      writeFile(
        'mentor_env/lib/leaked.thrift',
        `namespace java leaked.v1

service LeakedService {
  LeakedResponse Ping(1: LeakedRequest request)
}`,
      );
      writeFile('.gitnexusignore', 'mentor_env/\n');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      expect(
        contracts.find((c) => c.contractId === 'thrift::billing.v1.OrderService/PlaceOrder'),
      ).toBeDefined();
      expect(contracts.some((c) => c.symbolRef?.filePath?.startsWith('mentor_env/'))).toBe(false);
      expect(
        contracts.find((c) => c.contractId === 'thrift::leaked.v1.LeakedService/Ping'),
      ).toBeUndefined();
    });
  });

  // --- Annotation-based thrift client detection (#2629) ---
  // Note: End-to-end Java consumer tests are in conformance tests.
  // These tests verify the service name extraction logic.
  describe('annotation-based thrift client service name extraction (#2629)', () => {
    it('extracts service from ISimpleServiceClient pattern with ThriftClient annotation', () => {
      const result = serviceFromAnnotatedClient('ISimpleServiceClient', 'SimpleThriftClient');
      expect(result).toEqual({
        serviceName: 'SimpleService',
        usesGeneratedServiceMember: true,
      });
    });

    it('extracts service from ServiceClient pattern with RpcClient annotation', () => {
      const result = serviceFromAnnotatedClient('OrderServiceClient', 'OrderRpcClient');
      expect(result).toEqual({
        serviceName: 'OrderService',
        usesGeneratedServiceMember: true,
      });
    });

    it('extracts service from IClient pattern', () => {
      const result = serviceFromAnnotatedClient('IUserClient', 'UserThriftClient');
      expect(result).toEqual({
        serviceName: 'User',
        usesGeneratedServiceMember: true,
      });
    });

    it('handles qualified type names', () => {
      const result = serviceFromAnnotatedClient(
        'com.example.service.IOrderServiceClient',
        'OrderThriftClient',
      );
      expect(result).toEqual({
        serviceName: 'OrderService',
        usesGeneratedServiceMember: true,
      });
    });

    it('returns null for non-thrift annotations', () => {
      const result = serviceFromAnnotatedClient('SomeService', 'Autowired');
      expect(result).toBeNull();
    });

    it('returns null for negating annotations (@NotThriftClient)', () => {
      const result = serviceFromAnnotatedClient('OrderClient', 'NotThriftClient');
      expect(result).toBeNull();
    });

    it('returns null for non-Client type patterns', () => {
      const result = serviceFromAnnotatedClient('OrderService', 'OrderThriftClient');
      expect(result).toBeNull();
    });

    it('handles ServiceServiceClient pattern correctly', () => {
      const result = serviceFromAnnotatedClient('UserServiceServiceClient', 'UserThriftClient');
      expect(result).toEqual({
        serviceName: 'UserServiceService',
        usesGeneratedServiceMember: true,
      });
    });

    it('handles qualified annotation names', () => {
      const result = serviceFromAnnotatedClient(
        'IUserClient',
        'com.example.annotations.UserThriftClient',
      );
      expect(result).toEqual({
        serviceName: 'User',
        usesGeneratedServiceMember: true,
      });
    });

    it('handles single-character service names', () => {
      const result = serviceFromAnnotatedClient('IAClient', 'AThriftClient');
      expect(result).toEqual({
        serviceName: 'A',
        usesGeneratedServiceMember: true,
      });
    });
  });
});

describe('buildThriftContext', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-thrift-context-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('test_buildThriftContext_parses_namespace_service_methods_and_path', async () => {
    await fsp.mkdir(path.join(tmpDir, 'idl'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'idl', 'order.thrift'),
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
  OrderStatus GetOrderStatus(1: string orderId)
}`,
    );

    const context = await buildThriftContext(tmpDir);

    expect(context.namespacesByThrift.get('idl/order.thrift')).toBe('billing.v1');
    expect(context.servicesByName.get('OrderService')).toEqual([
      {
        namespace: 'billing.v1',
        serviceName: 'OrderService',
        methods: ['PlaceOrder', 'GetOrderStatus'],
        thriftPath: 'idl/order.thrift',
      },
    ]);
  });

  it('test_buildThriftContext_without_files_returns_empty_maps', async () => {
    const context = await buildThriftContext(tmpDir);

    expect(context.namespacesByThrift.size).toBe(0);
    expect(context.servicesByName.size).toBe(0);
  });

  it('skips .thrift files under .gitnexusignore paths (#1156-followup)', async () => {
    await fsp.mkdir(path.join(tmpDir, 'idl'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'idl', 'order.thrift'),
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    await fsp.mkdir(path.join(tmpDir, 'third_party'), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, 'third_party', 'leaked.thrift'),
      `namespace java leaked.v1

service LeakedService {
  LeakedResponse Ping(1: LeakedRequest request)
}`,
    );
    await fsp.writeFile(path.join(tmpDir, '.gitnexusignore'), 'third_party/\n');

    const context = await buildThriftContext(tmpDir);
    expect(context.servicesByName.has('OrderService')).toBe(true);
    expect(context.servicesByName.has('LeakedService')).toBe(false);
  });
});

describe('Thrift contract id helpers', () => {
  it('test_thriftMethodContractId_with_namespace', () => {
    expect(thriftMethodContractId('billing.v1', 'OrderService', 'PlaceOrder')).toBe(
      'thrift::billing.v1.OrderService/PlaceOrder',
    );
  });

  it('test_thriftMethodContractId_without_namespace', () => {
    expect(thriftMethodContractId('', 'OrderService', 'PlaceOrder')).toBe(
      'thrift::OrderService/PlaceOrder',
    );
  });

  it('test_thriftServiceContractId_with_namespace', () => {
    expect(thriftServiceContractId('billing.v1', 'OrderService')).toBe(
      'thrift::billing.v1.OrderService/*',
    );
  });

  it('test_thriftServiceContractId_without_namespace', () => {
    expect(thriftServiceContractId('', 'OrderService')).toBe('thrift::OrderService/*');
  });
});
