package example;

class BillingWorkflow {
  private OrderService.Iface orderService;

  void submit(PlaceOrderRequest request) throws Exception {
    orderService.PlaceOrder(request);
  }
}