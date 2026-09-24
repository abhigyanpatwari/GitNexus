package com.example.handlers;

import org.springframework.context.event.EventListener;

public class ApplicationEvents {
    @EventListener
    public void onOrderCreated(Object event) {
        validateEvent();
    }

    private void validateEvent() {
        projectOrder();
    }

    private void projectOrder() {}
}
