package demo;

import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

public class LookupService {

    // Group 1: same arity, generic parameter type (Collection<Long> vs Long)
    public Map<Long, Perm> find(Collection<Long> ids) {
        Map<Long, Perm> out = new HashMap<>();
        for (Long id : ids) out.put(id, new Perm(id));
        return out;
    }

    public Perm find(Long id) {
        return find(Collections.singletonList(id)).get(id);
    }

    // Group 2: same arity, no generics (String vs Long)
    public Perm resolve(String code) {
        return new Perm(Long.valueOf(code));
    }

    public Perm resolve(Long id) {
        return new Perm(id);
    }

    // Group 3 (control): different arity
    public int count(Req req) {
        return req.keyword == null ? 0 : 1;
    }

    public int count(Long id, Req req) {
        return count(req) + (id == null ? 0 : 1);
    }
}
