package demo;

import java.util.Arrays;
import java.util.Map;

public class BillingService {

    private final LookupService lookup;

    public BillingService(LookupService lookup) {
        this.lookup = lookup;
    }

    public Map<Long, Perm> settle() {
        return lookup.find(Arrays.asList(10L, 20L));   // -> find(Collection<Long>)
    }
}
