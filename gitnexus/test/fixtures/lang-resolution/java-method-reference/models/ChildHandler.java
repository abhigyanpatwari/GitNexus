package models;

import java.util.List;
import java.util.stream.Collectors;

public class ChildHandler extends BaseHandler {
    public List<String> wrapTransform(List<String> values) {
        return values.stream()
                .map(super::transform)
                .collect(Collectors.toList());
    }
}
