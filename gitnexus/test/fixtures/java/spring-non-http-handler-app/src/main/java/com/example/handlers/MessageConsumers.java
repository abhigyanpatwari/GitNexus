package com.example.handlers;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.messaging.handler.annotation.MessageMapping;
import jakarta.ws.rs.Path;

public class MessageConsumers {
    @KafkaListener(topics = "orders")
    public void consumeOrder(String payload) {
        decodeOrder();
    }

    @Path("/websocket-order")
    @MessageMapping("/orders")
    public void consumeOverWebSocket(String payload) {
        decodeOrder();
    }

    private void decodeOrder() {
        dispatchOrder();
    }

    private void dispatchOrder() {}
}
