package example;

class BillingWorkflow {
  @OrderThriftClient
  private IOrderServiceClient orderClient;

  @NonThriftClient
  private OrderClient negatedClient;

  void submit(PlaceOrderRequest request) throws Exception {
    orderClient.PlaceOrder(request);
    negatedClient.PlaceOrder(request);
  }
}
