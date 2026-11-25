namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}

service InvoiceService {
  Invoice CreateInvoice(1: string orderId)
}