package com.example.messaging;

import org.springframework.kafka.annotation.KafkaListener;

/**
 * One of two unrelated classes that each name the SAME configuration key and
 * nothing else. Neither says anything about the other, so they must not end up
 * on one destination node.
 */
public class InventoryConsumer {
    @KafkaListener(topics = "${app.messaging.shared-topic}")
    public void consume(String payload) {}
}
