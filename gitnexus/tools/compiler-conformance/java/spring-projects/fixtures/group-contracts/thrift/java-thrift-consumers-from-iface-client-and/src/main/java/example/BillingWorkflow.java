package example;

class BillingWorkflow {
  private OrderService.Iface orderService;
  private OrderService.Client orderClient;
  private OrderService generatedOrderService;

  void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
    orderClient.PlaceOrder(request);
    generatedOrderService.PlaceOrder(request);
  }
}