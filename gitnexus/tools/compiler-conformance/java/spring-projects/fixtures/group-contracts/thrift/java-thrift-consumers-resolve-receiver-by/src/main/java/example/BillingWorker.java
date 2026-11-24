package example;

class BillingWorker {
  void submitOrder(OrderService.Iface client, PlaceOrderRequest request) throws Exception {
    client.PlaceOrder(request);
  }

  void submitInvoice() throws Exception {
    InvoiceService.Client client = new InvoiceService.Client(null);
    client.CreateInvoice("order-1");
  }
}