package app;
import java.util.ArrayList;
import java.util.HashMap;
class Single {
  void arrayList(ArrayList<User> xs) { xs.forEach(u -> u.save()); }
  void hashMap(HashMap<String, Other> m) { for (var o : m.values()) o.save(); }
}