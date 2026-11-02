package com.example.messaging;

import org.springframework.kafka.annotation.KafkaListener;

/**
 * A DIFFERENT configuration key from ArchiveConsumer's, with the SAME default.
 * A default holds only while the key is not overridden, and configuration
 * values are deliberately absent from this graph, so the two must not merge on
 * a fallback they happen to share.
 */
public class ReportingConsumer {
    @KafkaListener(topics = "${app.messaging.report-topic:events}")
    public void consume(String payload) {}
}
