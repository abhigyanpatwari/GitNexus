package com.example.messaging;

import com.example.messaging.support.Topics;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.jms.annotation.JmsListener;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.messaging.handler.annotation.MessageMapping;

public class OrderConsumers {
    @KafkaListener(topics = "orders.v1")
    public void consumeLiteral(String payload) {}

    @KafkaListener(topics = Topics.SHIPMENTS)
    public void consumeConstant(String payload) {}

    @KafkaListener(topics = {"orders.v1", "returns.v1"})
    public void consumeMany(String payload) {}

    @KafkaListener(topics = "${app.messaging.audit-topic:audit.v1}")
    public void consumeConfiguredWithDefault(String payload) {}

    // A pattern over topic names, not a topic name.
    @KafkaListener(topicPattern = "orders\\..*")
    public void consumePattern(String payload) {}

    @RabbitListener(queues = "orders.queue")
    public void consumeQueue(String payload) {}

    @JmsListener(destination = "orders.jms")
    public void consumeJmsQueue(String payload) {}

    // A WebSocket/STOMP route, not a broker destination.
    @MessageMapping("/orders")
    public void consumeOverWebSocket(String payload) {}
}
