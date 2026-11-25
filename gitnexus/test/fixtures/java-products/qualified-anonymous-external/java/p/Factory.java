package p;
public class Factory {
  Object make() { return new external.B() {}; }
}
