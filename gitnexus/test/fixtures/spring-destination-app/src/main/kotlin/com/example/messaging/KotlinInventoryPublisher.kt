package com.example.messaging

import org.springframework.kafka.core.KafkaTemplate

/**
 * The other half of the string-template pair. Kotlin interpolates its literals,
 * so `"orders-$env"` is a value decided at runtime — byte-identical text in two
 * unrelated services that have said nothing about each other.
 */
class KotlinInventoryPublisher(
    private val kafkaTemplate: KafkaTemplate<String, String>,
    private val env: String,
) {
    fun publishTemplated(payload: String) {
        kafkaTemplate.send("orders-$env", payload)
    }
}
