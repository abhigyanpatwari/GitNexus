package com.example.messaging;

import org.springframework.amqp.rabbit.annotation.RabbitListener;

/**
 * A stranger on a name someone else already uses.
 *
 * `orders.v1` is a real Kafka pair in this fixture — OrderPublishers publishes
 * to it and OrderConsumers listens on it — and this class has nothing to do
 * with either. It just happens to have named its Rabbit queue the same way,
 * which is what a common word looks like in a large repository.
 *
 * While the address alone keyed the node, that coincidence was enough to
 * disconnect the pair: two brokers on one address cost EVERY site that named it
 * its address, so the publisher and the listener were re-keyed by source
 * location and stopped meeting. Keying on (broker, address) confines this file
 * to its own node and leaves the pair alone.
 */
public class UnrelatedRabbitConsumer {
    @RabbitListener(queues = "orders.v1")
    public void consume(String payload) {}
}
