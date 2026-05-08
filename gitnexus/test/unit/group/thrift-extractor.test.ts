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

  it('test_extract_java_thrift_consumers_from_iface_client_and_service_fields', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/main/java/example/BillingWorkflow.java',
      `package example;

class BillingWorkflow {
  private OrderService.Iface orderService;
  private OrderService.Client orderClient;
  private OrderService generatedOrderService;

  void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
    orderClient.PlaceOrder(request);
    generatedOrderService.PlaceOrder(request);
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumers = contracts
      .filter((c) => c.role === 'consumer')
      .sort((a, b) => a.symbolName.localeCompare(b.symbolName));

    expect(consumers).toHaveLength(3);
    expect(consumers.map((c) => c.symbolName)).toEqual([
      'generatedOrderService.PlaceOrder',
      'orderClient.PlaceOrder',
      'orderService.PlaceOrder',
    ]);
    for (const contract of consumers) {
      expect(contract).toMatchObject({
        contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
        type: 'thrift',
        role: 'consumer',
        confidence: 0.75,
        meta: {
          namespace: 'billing.v1',
          service: 'OrderService',
          method: 'PlaceOrder',
          source: 'java_thrift_consumer',
        },
      });
      expect(contract.symbolRef.filePath).toBe('src/main/java/example/BillingWorkflow.java');
    }
  });

  it('test_extract_java_thrift_consumers_from_this_field_access', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/main/java/example/BillingWorkflow.java',
      `package example;

class BillingWorkflow {
  private OrderService.Client orderClient;

  void submit(PlaceOrderRequest request) throws Exception {
    this.orderClient.PlaceOrder(request);
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumers = contracts.filter((c) => c.role === 'consumer');

    expect(consumers).toHaveLength(1);
    expect(consumers[0]).toMatchObject({
      contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
      type: 'thrift',
      role: 'consumer',
      symbolName: 'orderClient.PlaceOrder',
      confidence: 0.75,
      meta: {
        namespace: 'billing.v1',
        service: 'OrderService',
        method: 'PlaceOrder',
        source: 'java_thrift_consumer',
      },
    });
  });

  it('test_extract_java_thrift_consumers_from_fully_qualified_generated_types', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/main/java/example/BillingWorkflow.java',
      `package example;

class BillingWorkflow {
  private billing.v1.OrderService.Iface orderService;
  private billing.v1.OrderService.Client orderClient;

  void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
    orderClient.PlaceOrder(request);
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumers = contracts
      .filter((c) => c.role === 'consumer')
      .sort((a, b) => a.symbolName.localeCompare(b.symbolName));

    expect(consumers).toHaveLength(2);
    expect(consumers.map((c) => c.symbolName)).toEqual([
      'orderClient.PlaceOrder',
      'orderService.PlaceOrder',
    ]);
    expect(new Set(consumers.map((c) => c.contractId))).toEqual(
      new Set(['thrift::billing.v1.OrderService/PlaceOrder']),
    );
  });

  it('test_extract_java_thrift_consumers_from_local_variables', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/main/java/example/BillingWorker.java',
      `package example;

class BillingWorker {
  void submit(OrderService.Iface iface, OrderService.Client client, OrderService service) throws Exception {
    OrderService.Iface orderService = iface;
    OrderService.Client orderClient = client;
    OrderService generatedOrderService = service;

    orderService.PlaceOrder(new PlaceOrderRequest());
    orderClient.PlaceOrder(new PlaceOrderRequest());
    generatedOrderService.PlaceOrder(new PlaceOrderRequest());
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumers = contracts.filter((c) => c.role === 'consumer');

    expect(consumers.map((c) => c.symbolName).sort()).toEqual([
      'generatedOrderService.PlaceOrder',
      'orderClient.PlaceOrder',
      'orderService.PlaceOrder',
    ]);
    expect(new Set(consumers.map((c) => c.contractId))).toEqual(
      new Set(['thrift::billing.v1.OrderService/PlaceOrder']),
    );
  });

  it('test_extract_java_thrift_consumers_resolve_receiver_by_nearest_scope', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}

service InvoiceService {
  Invoice CreateInvoice(1: string orderId)
}`,
    );
    writeFile(
      'src/main/java/example/BillingWorker.java',
      `package example;

class BillingWorker {
  void submitOrder(OrderService.Iface client, PlaceOrderRequest request) throws Exception {
    client.PlaceOrder(request);
  }

  void submitInvoice() throws Exception {
    InvoiceService.Client client = new InvoiceService.Client(null);
    client.CreateInvoice("order-1");
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const consumers = contracts
      .filter((c) => c.role === 'consumer')
      .sort((a, b) => a.contractId.localeCompare(b.contractId));

    expect(consumers.map((c) => c.contractId)).toEqual([
      'thrift::billing.v1.InvoiceService/CreateInvoice',
      'thrift::billing.v1.OrderService/PlaceOrder',
    ]);
    expect(consumers.map((c) => c.symbolName).sort()).toEqual([
      'client.CreateInvoice',
      'client.PlaceOrder',
    ]);
  });

  it('test_extract_java_thrift_providers_from_iface_and_service_implements', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/main/java/example/IfaceOrderHandler.java',
      `package example;

class IfaceOrderHandler implements OrderService.Iface {
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse();
  }
}`,
    );
    writeFile(
      'src/main/java/example/GeneratedOrderHandler.java',
      `package example;

class GeneratedOrderHandler implements OrderService {
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse();
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const providers = contracts
      .filter((c) => c.meta.source === 'java_thrift_provider')
      .sort((a, b) => a.symbolRef.filePath.localeCompare(b.symbolRef.filePath));

    expect(providers).toHaveLength(2);
    for (const contract of providers) {
      expect(contract).toMatchObject({
        contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
        type: 'thrift',
        role: 'provider',
        symbolName: 'OrderService.PlaceOrder',
        confidence: 0.8,
        meta: {
          namespace: 'billing.v1',
          service: 'OrderService',
          method: 'PlaceOrder',
          source: 'java_thrift_provider',
        },
      });
    }
  });

  it('test_extract_thrift_source_scan_contracts_have_stable_distinct_symbol_uids', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/main/java/example/IfaceOrderHandler.java',
      `package example;

class IfaceOrderHandler implements OrderService.Iface {
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse();
  }
}`,
    );

    const first = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const second = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const providers = first
      .filter((c) => c.role === 'provider')
      .sort((a, b) => a.symbolRef.filePath.localeCompare(b.symbolRef.filePath));
    const repeatedProviders = second
      .filter((c) => c.role === 'provider')
      .sort((a, b) => a.symbolRef.filePath.localeCompare(b.symbolRef.filePath));

    expect(providers).toHaveLength(2);
    expect(providers.map((c) => c.symbolUid)).toEqual(repeatedProviders.map((c) => c.symbolUid));
    expect(providers.every((c) => c.symbolUid.length > 0)).toBe(true);
    expect(new Set(providers.map((c) => c.symbolUid)).size).toBe(2);
    expect(providers.every((c) => !c.symbolUid.includes('::thrift::billing.v1'))).toBe(true);
  });

  it('test_extract_java_thrift_providers_from_fully_qualified_generated_iface', async () => {
    writeFile(
      'idl/order.thrift',
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    writeFile(
      'src/main/java/example/IfaceOrderHandler.java',
      `package example;

class IfaceOrderHandler implements billing.v1.OrderService.Iface {
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse();
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
    const providers = contracts.filter((c) => c.meta.source === 'java_thrift_provider');

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
      type: 'thrift',
      role: 'provider',
      symbolName: 'OrderService.PlaceOrder',
      confidence: 0.8,
      meta: {
        namespace: 'billing.v1',
        service: 'OrderService',
        method: 'PlaceOrder',
        source: 'java_thrift_provider',
      },
    });
  });

  it('test_extract_java_thrift_consumer_without_idl_emits_weak_method_contract', async () => {
    writeFile(
      'src/main/java/example/BillingWorkflow.java',
      `package example;

class BillingWorkflow {
  private OrderService.Iface orderService;

  void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      contractId: 'thrift::OrderService/PlaceOrder',
      type: 'thrift',
      role: 'consumer',
      symbolName: 'orderService.PlaceOrder',
      confidence: 0.45,
      meta: {
        service: 'OrderService',
        method: 'PlaceOrder',
        source: 'java_thrift_consumer_weak',
      },
    });
    expect(contracts[0].symbolRef.filePath).toBe('src/main/java/example/BillingWorkflow.java');
  });

  it('test_extract_java_thrift_direct_service_consumer_without_idl_returns_empty', async () => {
    writeFile(
      'src/main/java/example/PaymentWorkflow.java',
      `package example;

class PaymentWorkflow {
  private PaymentService paymentService;

  void submit() {
    paymentService.charge();
  }
}`,
    );

    const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));

    expect(contracts).toEqual([]);
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
