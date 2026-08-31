package com.example.handlers

import org.springframework.amqp.rabbit.core.RabbitTemplate
import org.springframework.beans.factory.annotation.Value
import org.springframework.cloud.stream.function.StreamBridge
import org.springframework.jms.core.JmsTemplate
import org.springframework.kafka.core.KafkaTemplate

class KotlinOrderPublishers(
    private val kafkaTemplate: KafkaTemplate<String, String>,
    private val rabbitTemplate: RabbitTemplate,
    private val jmsTemplate: JmsTemplate,
    private val streamBridge: StreamBridge,
) {
    @Value("\${app.messaging.orders-topic}")
    private lateinit var ordersTopic: String

    fun publishLiteralDestination(payload: String) {
        kafkaTemplate.send("orders", payload)
    }

    fun publishConstantDestination(payload: String) {
        this.kafkaTemplate.send(Destinations.SHIPMENTS, payload)
    }

    fun publishConfiguredDestination(payload: String) {
        kafkaTemplate.send(ordersTopic, payload)
    }

    fun publishWithNamedArguments(payload: String) {
        kafkaTemplate.send(topic = "orders", data = payload)
    }

    fun publishToExchange(exchange: String, routingKey: String, payload: String) {
        rabbitTemplate.convertAndSend(exchange, routingKey, payload)
    }

    fun publishToQueue(payload: String) {
        jmsTemplate.convertAndSend("queue.orders", payload)
    }

    fun publishToBinding(payload: String) {
        streamBridge.send("orders-out-0", payload)
    }
}
