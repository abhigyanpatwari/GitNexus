package com.example.messaging;

import org.springframework.kafka.annotation.KafkaListener;

/** The other half of the SpEL pair, byte-identical expression, different file. */
public class LedgerSpelConsumer {
    @KafkaListener(topics = "#{@messagingProperties.ordersTopic}")
    public void consume(String payload) {}
}
