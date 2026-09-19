package com.example.messaging;

import org.springframework.kafka.annotation.KafkaListener;

/**
 * One of two unrelated services that each name the SAME SpEL expression. The
 * container evaluates it against live beans at runtime, so nothing in the
 * source says what it is — and neither service has said anything about the
 * other. Keyed on the expression text they would read as connected.
 */
public class PricingSpelConsumer {
    @KafkaListener(topics = "#{@messagingProperties.ordersTopic}")
    public void consume(String payload) {}
}
