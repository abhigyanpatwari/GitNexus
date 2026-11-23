package demo;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

public class OrderService {

    private final LookupService lookup;

    public OrderService(LookupService lookup) {
        this.lookup = lookup;
    }

    public Map<Long, Perm> listOrders() {
        List<Long> ids = Arrays.asList(1L, 2L, 3L);
        return lookup.find(ids);              // -> find(Collection<Long>)
    }

    public Perm getOrder(Long id) {
        return lookup.find(id);               // -> find(Long)
    }

    public Perm byCode(String code) {
        return lookup.resolve(code);          // -> resolve(String)
    }

    public Perm byId(Long id) {
        return lookup.resolve(id);            // -> resolve(Long)
    }

    public int summarize(Long id, Req req) {
        return lookup.count(req) + lookup.count(id, req);   // -> count(Req), count(Long, Req)
    }
}
