package com.example.messaging;

import org.apache.kafka.clients.producer.ProducerRecord;
import com.example.messaging.support.Topics;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.cloud.stream.function.StreamBridge;
import org.springframework.jms.core.JmsTemplate;
import org.springframework.kafka.core.KafkaTemplate;

public class OrderPublishers {
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final RabbitTemplate rabbitTemplate;
    private final JmsTemplate jmsTemplate;
    private final StreamBridge streamBridge;

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

    /** Meets OrderConsumers#consumeLiteral on one destination node. */
    public void publishLiteral(String payload) {
        kafkaTemplate.send("orders.v1", payload);
    }

    /** Meets OrderConsumers#consumeConstant, through the same constant. */
    public void publishConstant(String payload) {
        this.kafkaTemplate.send(Topics.SHIPMENTS, payload);
    }

    /** The destination is inside the record; nothing here names it. */
    public void publishRecord(ProducerRecord<String, String> record) {
        kafkaTemplate.send(record);
    }

    /**
     * The routing key is a CONSTANT, and that is what makes this readable:
     * (exchange, routingKey, message) and (routingKey, message,
     * correlationData) are both three arguments, so only the shape of slot 1
     * separates them. A constant is how a configured NAME is written.
     */
    public void publishToExchange(String payload) {
        rabbitTemplate.convertAndSend("orders.exchange", Topics.ORDERS_ROUTING_KEY, payload);
    }

    /**
     * The same arity with a string LITERAL in slot 1, which is no evidence at
     * all: under (routingKey, message, correlationData) the literal is the
     * PAYLOAD. Reading it as the address would join a listener on a queue that
     * merely happens to be named after the payload text, so nothing is emitted.
     */
    public void publishWithAmbiguousOverload(CorrelationData correlationData) {
        rabbitTemplate.convertAndSend("orders.rk", "body", correlationData);
    }

    /**
     * An ordinary Spring AMQP publish whose ROUTING KEY is a variable. Arity
     * cannot tell this from convertAndSend(routingKey, message, postProcessor),
     * and the discarded positional fallback published EXCHANGES as the address
     * — a plausible-looking wrong answer that could join a listener on a queue
     * of that name.
     */
    public void publishToExchangeWithVariableRoutingKey(String routingKey, String payload) {
        rabbitTemplate.convertAndSend(Topics.ORDERS_EXCHANGE, routingKey, payload);
    }

    /** Default exchange, empty routing key — no address is written anywhere. */
    public void publishToDefaultExchange(String payload) {
        rabbitTemplate.convertAndSend(payload);
    }

    public void publishToQueue(String payload) {
        jmsTemplate.convertAndSend("orders.jms", payload);
    }

    /**
     * The same address a @RabbitListener subscribes to, over a different
     * broker. The broker is inferred from a receiver's NAME, so a disagreement
     * is far more likely to be a bad guess than two brokers sharing an address
     * — the node records it rather than merging it away or dropping the
     * connection the two sides agree on.
     */
    public void publishToConflictingBroker(String payload) {
        jmsTemplate.convertAndSend("orders.queue", payload);
    }

    public void publishToBinding(String payload) {
        streamBridge.send("orders-out-0", payload);
    }

    /** No default: the value lives in configuration, which stays out of the graph. */
    public void publishToConfigured(String payload) {
        kafkaTemplate.send("${app.messaging.shared-topic}", payload);
    }
}
