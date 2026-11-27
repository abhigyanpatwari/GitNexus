package app;
import java.util.List;
public class Overloads {
  public List<User> load(String key) { return null; }
  public List<Other> load(Integer key) { return null; }
}