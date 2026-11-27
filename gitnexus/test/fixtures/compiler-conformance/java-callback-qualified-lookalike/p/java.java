package p;
import java.util.function.Consumer;
import java.util.function.BiConsumer;
import java.util.Iterator;
import java.util.Collection;
import java.util.Collections;
public class java {
  public static class util {
    public static class List<T> implements Iterable<Other> {
      public void forEach(Consumer<? super Other> callback) {}
      public Iterator<Other> iterator() { return Collections.emptyIterator(); }
    }
    public static class Map<K,V> {
      public Collection<Other> values() { return Collections.emptyList(); }
      public void forEach(BiConsumer<Other,Other> callback) {}
    }
  }
}
