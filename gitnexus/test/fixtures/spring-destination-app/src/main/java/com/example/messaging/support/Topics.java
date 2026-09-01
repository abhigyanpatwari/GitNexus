package com.example.messaging.support;

/** Destination names shared by the publisher and the consumer sides. */
public final class Topics {
    public static final String ORDERS = "orders.v1";
    public static final String SHIPMENTS = "shipments.v1";
    /** An exchange, not an address: it names where a routing key is published,
     *  and a listener names a QUEUE, so the two sides never meet on it. */
    public static final String ORDERS_EXCHANGE = "orders.exchange";

    private Topics() {}
}
