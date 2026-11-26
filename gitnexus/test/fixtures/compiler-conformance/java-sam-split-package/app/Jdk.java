package app; import java.util.function.*; import partial.*;
class Jdk { void run(Consumer<model.User> cb) {} void call() { run(x -> x.save()); } }
