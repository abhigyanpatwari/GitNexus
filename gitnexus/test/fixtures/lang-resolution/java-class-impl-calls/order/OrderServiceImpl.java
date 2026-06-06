package order;

/**
 * OrderServiceImpl — implementation. Exercised by OrderController via
 * interface-typed field. Used for the #34 regression (the bug report
 * named OrderService specifically).
 */
public class OrderServiceImpl implements OrderService {
    @Override
    public String getOrder(String id) {
        return "order:" + id;
    }

    @Override
    public void deleteOrder(String id) {
        // marker
    }
}
