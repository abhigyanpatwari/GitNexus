package example;

class IfaceOrderHandler implements billing.v1.OrderService.Iface {
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse();
  }
}