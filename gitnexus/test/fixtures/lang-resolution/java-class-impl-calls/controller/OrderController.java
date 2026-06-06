package controller;

import order.OrderService;

/**
 * OrderController — sibling controller to UserController. Same shape:
 * interface-typed field, method-level CALLS to interface methods. The
 * IMPLEMENTS walk surfaces its callers in context(OrderServiceImpl).
 */
public class OrderController {
    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    public String show(String id) {
        return orderService.getOrder(id);
    }

    public void cancel(String id) {
        orderService.deleteOrder(id);
    }
}
