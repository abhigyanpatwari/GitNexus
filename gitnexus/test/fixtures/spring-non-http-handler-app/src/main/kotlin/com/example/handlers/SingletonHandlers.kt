package com.example.handlers

import org.springframework.context.event.EventListener
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.scheduling.annotation.Scheduled

object CacheWarmer {
    @Scheduled(fixedRate = 60_000)
    fun warmSingleton() {
        refreshCache()
    }

    private fun refreshCache() {
        persistCache()
    }

    private fun persistCache() {}
}

class CompanionEventHandlers {
    companion object {
        @EventListener
        fun onCompanionEvent(event: Any) {
            recordCompanionEvent()
        }

        private fun recordCompanionEvent() {
            persistCompanionEvent()
        }

        private fun persistCompanionEvent() {}
    }
}

enum class EnumMessageHandlers {
    CREATED;

    @KafkaListener(topics = ["enum-orders"])
    fun consumeEnumMessage(payload: String) {
        recordEnumMessage()
    }

    private fun recordEnumMessage() {
        persistEnumMessage()
    }

    private fun persistEnumMessage() {}
}
