package p;
class Impl implements Handler { public void handle() {} }
class Caller { void run(Handler h) { h.handle(); } }
