package com.example.messaging

import org.springframework.kafka.core.KafkaTemplate

class KotlinOrderPublishers(
    private val kafkaTemplate: KafkaTemplate<String, String>,
    private val env: String,
) {
    /** Meets both Java and Kotlin consumers on the same destination node. */
    fun publishLiteral(payload: String) {
        kafkaTemplate.send("orders.v1", payload)
    }

    /** A Kotlin `object` constant, folded by the Kotlin binding of the same
     *  constant resolver the Java side uses. */
    fun publishConstant(payload: String) {
        kafkaTemplate.send(KotlinTopics.INVENTORY, payload)
    }

    /** A Kotlin string TEMPLATE. The short form has no braces at all, so a
     *  `${'$'}{` test never saw it and it was read as the literal address
     *  `orders-${'$'}env`, shared with every other service that wrote the same
     *  three words. */
    fun publishTemplated(payload: String) {
        kafkaTemplate.send("orders-$env", payload)
    }

    /** The braced form of the same template, which was read as a SPRING
     *  placeholder and invented a configuration key named `env`. */
    fun publishBracedTemplate(payload: String) {
        kafkaTemplate.send("orders-${env}", payload)
    }

    /** The ESCAPED form, which is how a Spring placeholder must be written in
     *  Kotlin. This one is a real placeholder and must keep working. */
    fun publishEscapedPlaceholder(payload: String) {
        kafkaTemplate.send("\${app.messaging.shared-topic}", payload)
    }
}
