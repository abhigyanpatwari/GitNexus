package ondemand;
import java.util.*;
class Use {
  void run(List<Item> values) { values.forEach(value -> value.save()); }
}
