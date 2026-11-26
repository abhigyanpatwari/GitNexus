package example;

class PaymentWorkflow {
  private PaymentService paymentService;

  void submit() {
    paymentService.charge();
  }
}