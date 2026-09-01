package com.example.messaging;

import org.springframework.kafka.annotation.KafkaListener;

/**
 * The other half of the pair. Byte-identical placeholder text to
 * InventoryConsumer, in a different file — the case that a text-keyed
 * destination node would silently merge into one false connection.
 */
public class BillingConsumer {
    @KafkaListener(topics = "${app.messaging.shared-topic}")
    public void consume(String payload) {}
}
