package com.example.handlers

import org.springframework.context.event.EventListener as SpringEvent

interface ListenerContract {
    @SpringEvent
    fun interfaceEvent(event: Any) {
        interfaceStep()
    }

    fun interfaceStep() {}
}
