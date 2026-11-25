package app;
class Pass {
  void pass(Sink s, models.User models) { s.take(models); }
  void passOther(Sink s, models.Other models) { s.take(models); }
}
