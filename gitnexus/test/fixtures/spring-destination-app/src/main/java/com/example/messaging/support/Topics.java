package com.example.messaging.support;

/** Destination names shared by the publisher and the consumer sides. */
public final class Topics {
    public static final String SHIPMENTS = "shipments.v1";
    /** An exchange, not an address: it names where a routing key is published,
     *  and a listener names a QUEUE, so the two sides never meet on it. */
    public static final String ORDERS_EXCHANGE = "orders.exchange";
    /** A routing key. Written as a constant on purpose: at three arguments the
     *  exchange overload and the correlation-data overload are spelled the
     *  same, and the shape of this slot is the only thing that separates them. */
    public static final String ORDERS_ROUTING_KEY = "orders.created";

    private Topics() {}
}
