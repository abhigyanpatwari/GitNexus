package example;

class BillingWorkflow {
  private billing.v1.OrderService.Iface orderService;
  private billing.v1.OrderService.Client orderClient;

  void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
    orderClient.PlaceOrder(request);
  }
}