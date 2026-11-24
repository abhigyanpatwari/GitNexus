package example;

class BillingWorkflow {
  private OrderService.Client orderClient;

  void submit(PlaceOrderRequest request) throws Exception {
    this.orderClient.PlaceOrder(request);
  }
}