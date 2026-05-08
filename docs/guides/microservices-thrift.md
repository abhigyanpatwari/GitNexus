# Using GitNexus across Apache Thrift microservices

## When to use this guide

Use this guide when several repositories communicate through Apache Thrift and you want GitNexus to trace impact across provider and consumer boundaries. The walkthrough assumes each service is indexed on its own, then joined through a GitNexus group.

This is not a framework integration guide. GitNexus reads portable Thrift IDL and common Java generated-code shapes. Framework-specific wiring, service discovery, deployment metadata, and private annotations belong outside the open-source core.

## Mental model

- `.thrift` files define the canonical service contract. A method in an IDL service becomes a stable contract id in the form `thrift::<namespace>.<Service>/<Method>`.
- Service wildcard ids in the form `thrift::<namespace>.<Service>/*` are supported as manifest and matching fallback forms when a service-level link is needed.
- Java generated-code usage points GitNexus toward implementation and call sites. Providers commonly implement generated `Service.Iface`; consumers commonly hold or construct generated service interfaces or clients.
- Group sync matches provider and consumer contracts with the same id, then cross-repo impact can hop through those links.
- Framework-specific wiring should be modeled by extractor plugins, manifest links, or downstream integrations rather than hard-coded into core Thrift support.

## Fictional IDL

```thrift
namespace java billing.v1

struct PlaceOrderRequest {
  1: string orderId
  2: double amount
}

struct PlaceOrderResponse {
  1: bool accepted
}

struct GetOrderRequest {
  1: string orderId
}

struct GetOrderResponse {
  1: string orderId
  2: string status
}

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
  GetOrderResponse GetOrder(1: GetOrderRequest request)
}
```

The service methods above produce canonical ids:

- `thrift::billing.v1.OrderService/PlaceOrder`
- `thrift::billing.v1.OrderService/GetOrder`
- `thrift::billing.v1.OrderService/*` as a service-level manifest or matching fallback form

## Java provider example

Generated Java code usually exposes an `Iface` interface for the service. A provider implementation can be detected when it implements that generated interface.

```java
package example.billing;

import billing.v1.GetOrderRequest;
import billing.v1.GetOrderResponse;
import billing.v1.OrderService;
import billing.v1.PlaceOrderRequest;
import billing.v1.PlaceOrderResponse;

public final class OrderServiceHandler implements OrderService.Iface {
  @Override
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse(true);
  }

  @Override
  public GetOrderResponse GetOrder(GetOrderRequest request) {
    return new GetOrderResponse(request.getOrderId(), "CREATED");
  }
}
```

With the IDL available, GitNexus can connect the implementation to `thrift::billing.v1.OrderService/PlaceOrder` and `thrift::billing.v1.OrderService/GetOrder`.

## Java consumer examples

Consumers are strongest when Java usage can be tied back to the IDL namespace and service.

```java
package example.checkout;

import billing.v1.OrderService;
import billing.v1.PlaceOrderRequest;

public final class CheckoutWorkflow {
  private final OrderService.Iface orders;

  public CheckoutWorkflow(OrderService.Iface orders) {
    this.orders = orders;
  }

  public void submit(String orderId) throws Exception {
    orders.PlaceOrder(new PlaceOrderRequest(orderId, 42.0));
  }
}
```

Some generated-code styles use the generated service type directly while keeping enough IDL context through imports and method calls.

```java
package example.reporting;

import billing.v1.GetOrderRequest;
import billing.v1.OrderService;

public final class OrderLookup {
  private final OrderService.Client client;

  public OrderLookup(OrderService.Client client) {
    this.client = client;
  }

  public String status(String orderId) throws Exception {
    return client.GetOrder(new GetOrderRequest(orderId)).getStatus();
  }
}
```

When IDL context is missing, GitNexus may still emit a weaker consumer signal for generated `Iface` or `Client` shapes, but confidence is lower.

## Group configuration

New group configs enable Thrift contract detection by default. Keep `detect.thrift: true`
when a group should scan for Thrift contracts, or set it to `false` to skip Thrift
extraction for that group.

```yaml
version: 1
name: billing-platform
description: Fictional services connected by Apache Thrift

repos:
  checkout: checkout-service
  billing: billing-service

links: []

detect:
  http: true
  grpc: false
  thrift: true
  topics: false
  shared_libs: true
```

To disable Thrift extraction explicitly:

```yaml
detect:
  thrift: false
```

After indexing each member repository, run group sync to extract contracts and write cross-repo links:

```bash
npx gitnexus group sync billing-platform
```

## Manifest escape hatch

Use manifest links when automatic extraction cannot see a provider or consumer, or when generated code is wrapped behind an abstraction. Write the contract without the `thrift::` prefix; GitNexus canonicalizes it to the full Thrift contract id.

```yaml
links:
  - from: checkout
    to: billing
    type: thrift
    contract: billing.v1.OrderService/PlaceOrder
    role: consumer
```

GitNexus canonicalizes that manifest entry to `thrift::billing.v1.OrderService/PlaceOrder` and uses it to connect the two repositories.

## Known limitations

- Java detection currently targets v1 generated-code patterns.
- Maven and POM dependency coordinates are not used for inference.
- Framework-specific annotations and service discovery metadata are ignored by open-source Thrift extraction.
- Ambiguous same-name services are skipped instead of guessed.
- Java consumers without IDL context are lower confidence and limited to generated `Iface` and `Client` shapes.
