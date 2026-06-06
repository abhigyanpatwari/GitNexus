package order;

/**
 * OrderService interface. Tests that the IMPLEMENTS walk surfaces callers
 * when querying a sibling interface, not just the impl class. The same
 * controller-style wiring as UserService.
 */
public interface OrderService {
    String getOrder(String id);
    void deleteOrder(String id);
}
