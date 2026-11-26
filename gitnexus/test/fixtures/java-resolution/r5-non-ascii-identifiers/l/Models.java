package l;
import lombok.Getter;
import lombok.Value;
public class Models {}
class Mödel extends Basé { @Getter private Item nämé; }
class Model extends Base { @Getter private Item name; }
@Getter class Klässe extends Basé { private Item fëld; }
@Value class Wërt extends Basé { Item wërt; }
class Other {
  Item getNämé() { return null; }
  Item getName() { return null; }
  Item getFëld() { return null; }
  Item getWërt() { return null; }
}