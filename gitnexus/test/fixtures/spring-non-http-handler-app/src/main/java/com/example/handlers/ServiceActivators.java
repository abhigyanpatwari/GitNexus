package com.example.handlers;

import com.example.fake.Bean;
import org.springframework.integration.annotation.ServiceActivator;

public class ServiceActivators {
    @org.springframework.context.annotation.Bean
    @ServiceActivator(inputChannel = "errorChannel")
    public Object beanFactoryServiceActivator() {
        return buildErrorHandler();
    }

    @Bean
    @ServiceActivator(inputChannel = "orders")
    public void fakeBeanServiceActivator(String payload) {
        dispatchMessage();
    }

    private Object buildErrorHandler() {
        return new Object();
    }

    private void dispatchMessage() {
        persistMessage();
    }

    private void persistMessage() {}
}
