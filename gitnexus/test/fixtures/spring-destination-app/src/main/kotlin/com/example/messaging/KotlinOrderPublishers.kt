package com.example.messaging

import org.springframework.kafka.core.KafkaTemplate

class KotlinOrderPublishers(
    private val kafkaTemplate: KafkaTemplate<String, String>,
) {
    /** Meets both Java and Kotlin consumers on the same destination node. */
    fun publishLiteral(payload: String) {
        kafkaTemplate.send("orders.v1", payload)
    }
}
