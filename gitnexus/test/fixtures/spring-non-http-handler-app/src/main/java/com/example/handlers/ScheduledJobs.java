package com.example.handlers;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.context.event.EventListener;

public class ScheduledJobs {
    @Scheduled(fixedDelayString = "PT1M")
    public void refreshProjection() {
        loadPendingChanges();
    }

    @Scheduled(fixedDelayString = "PT5M")
    @EventListener
    public void refreshAfterEvent(Object event) {
        loadPendingChanges();
    }

    private void loadPendingChanges() {
        storeProjection();
    }

    private void storeProjection() {}
}
