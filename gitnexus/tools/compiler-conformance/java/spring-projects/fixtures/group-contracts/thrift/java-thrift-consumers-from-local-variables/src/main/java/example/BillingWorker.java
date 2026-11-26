package example;

class BillingWorker {
  void submit(OrderService.Iface iface, OrderService.Client client, OrderService service) throws Exception {
    OrderService.Iface orderService = iface;
    OrderService.Client orderClient = client;
    OrderService generatedOrderService = service;

    orderService.PlaceOrder(new PlaceOrderRequest());
    orderClient.PlaceOrder(new PlaceOrderRequest());
    generatedOrderService.PlaceOrder(new PlaceOrderRequest());
  }
}