package app; import own.*; import partial.*;
class Workspace { void run(Sink cb) {} void call() { run(x -> x.save()); } }
