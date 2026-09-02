package com.example.messaging;

import org.springframework.kafka.annotation.KafkaListener;

/** The other half of the shared-default pair. */
public class ArchiveConsumer {
    @KafkaListener(topics = "${app.messaging.archive-topic:events}")
    public void consume(String payload) {}
}
