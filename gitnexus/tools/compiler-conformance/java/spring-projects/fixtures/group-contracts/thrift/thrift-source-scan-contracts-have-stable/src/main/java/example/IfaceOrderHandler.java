package example;

class IfaceOrderHandler implements OrderService.Iface {
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse();
  }
}