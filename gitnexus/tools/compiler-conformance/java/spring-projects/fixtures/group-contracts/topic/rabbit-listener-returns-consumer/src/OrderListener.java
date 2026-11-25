@RabbitListener(queues = "order-queue")
public void processOrder(OrderMessage msg) {}