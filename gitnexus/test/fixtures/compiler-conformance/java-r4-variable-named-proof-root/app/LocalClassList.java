package app;
import java.util.*;
import models.User;
import models.Other;
class LocalClassList {
  void run() {
    class List<T> implements Iterable<Other> { public Iterator<Other> iterator() { return null; } }
    List<User> users = new List<>();
    for (var u : users) u.save();
  }
}
