package com.example.messaging

import org.springframework.kafka.annotation.KafkaListener

class KotlinOrderConsumers {
    @KafkaListener(topics = ["orders.v1", "returns.v1"])
    fun consumeArray(payload: String) {}

    @KafkaListener(topics = arrayOf("kotlin.arrayof.v1"))
    fun consumeArrayOf(payload: String) {}

    // Kotlin has to escape the dollar or the compiler reads a string template.
    @KafkaListener(topics = ["\${app.messaging.shared-topic}"])
    fun consumePlaceholder(payload: String) {}

    @KafkaListener(topics = ["\${app.messaging.audit-topic:audit.v1}"])
    fun consumePlaceholderWithDefault(payload: String) {}
}
