package app;
import java.util.List;
public class Generic {
  public <User> List<User> shadowed() { return null; }
  public <T> List<T> generic() { return null; }
}