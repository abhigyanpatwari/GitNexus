package p;
public interface Handler { void handle(); }
class Registry { interface Handler {} }
class Local implements Registry.Handler {}
