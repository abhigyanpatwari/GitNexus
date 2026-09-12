package com.example.handlers;

import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.stream.function.StreamBridge;
import org.springframework.jms.core.JmsTemplate;
import org.springframework.kafka.core.KafkaTemplate;

public class OrderPublishers {
    private static final String SHIPMENTS_TOPIC = "shipments";

    private final KafkaTemplate<String, String> kafkaTemplate;
    private final RabbitTemplate rabbitTemplate;
    private final JmsTemplate jmsTemplate;
    private final StreamBridge streamBridge;

    @Value("${app.messaging.orders-topic}")
    private String ordersTopic;

    public OrderPublishers(
            KafkaTemplate<String, String> kafkaTemplate,
            RabbitTemplate rabbitTemplate,
            JmsTemplate jmsTemplate,
            StreamBridge streamBridge) {
        this.kafkaTemplate = kafkaTemplate;
        this.rabbitTemplate = rabbitTemplate;
        this.jmsTemplate = jmsTemplate;
        this.streamBridge = streamBridge;
    }

    public void publishLiteralDestination(String payload) {
        kafkaTemplate.send("orders", payload);
    }

    public void publishConstantDestination(String payload) {
        this.kafkaTemplate.send(SHIPMENTS_TOPIC, payload);
    }

    public void publishConfiguredDestination(String payload) {
        kafkaTemplate.send(ordersTopic, payload);
    }

    public void publishToExchange(String exchange, String routingKey, String payload) {
        rabbitTemplate.convertAndSend(exchange, routingKey, payload);
    }

    public void publishToQueue(String payload) {
        jmsTemplate.convertAndSend("queue.orders", payload);
    }

    public void publishToBinding(String payload) {
        streamBridge.send("orders-out-0", payload);
    }
}
