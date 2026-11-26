package app; import own.Sink; import partial.*;
class Explicit { void run(Sink cb) {} void call() { run(x -> x.save()); } }
