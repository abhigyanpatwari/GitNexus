package services;

import java.util.List;
import java.util.stream.Collectors;
import models.ResponseBuilder;
import models.User;
import util.FormatUtil;

public class MethodRefService {
    private ResponseBuilder responseBuilder;

    /**
     * Instance-bound reference (Synapse-style: mapVar::method).
     */
    public List<String> mapViaInstanceBuilder(List<String> inputs) {
        return inputs.stream()
                .map(responseBuilder::buildResponse)
                .collect(Collectors.toList());
    }

    /**
     * Static method on a project class (not JDK) — {@code Util::staticMethod}.
     */
    public List<String> mapViaStaticUtil(List<Object> values) {
        return values.stream()
                .map(FormatUtil::format)
                .collect(Collectors.toList());
    }

    /**
     * Unbound instance method reference — {@code Type::instanceMethod}.
     */
    public List<String> mapUserNames(List<User> users) {
        return users.stream()
                .map(User::getName)
                .collect(Collectors.toList());
    }

    /**
     * Constructor reference — {@code Type::new}.
     */
    public List<User> mapNewUsers(List<String> names) {
        return names.stream()
                .map(User::new)
                .collect(Collectors.toList());
    }

    /**
     * {@code this::instanceMethod} on enclosing class.
     */
    public List<Boolean> mapSaves(List<User> users) {
        return users.stream()
                .map(this::saveOne)
                .collect(Collectors.toList());
    }

    private boolean saveOne(User user) {
        return user.save();
    }
}
