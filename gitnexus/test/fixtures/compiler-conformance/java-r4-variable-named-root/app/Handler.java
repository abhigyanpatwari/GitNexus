package app;
class Handler {
  void accept(cb.UserCb cb) {}
  void use(Handler h) { h.accept(x -> x.save()); }
}
