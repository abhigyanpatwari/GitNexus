package com.example.handlers

import org.springframework.context.event.EventListener as SpringEvent

class AliasedEvents {
    @SpringEvent
    fun onKotlinEvent(event: Any) {
        normalizeEvent()
    }

    private fun normalizeEvent() {
        persistEvent()
    }

    private fun persistEvent() {}
}
