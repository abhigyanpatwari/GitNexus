package shadow; import java.util.function.Consumer;
public class java {
  public static class util {
    public static class List<T> {
      public void forEach(Consumer<ShadowOther> callback) {}
    }
    public static class Set<T> {
      public void forEach(ShadowCallback<ShadowOther> callback) {}
    }
  }
}
