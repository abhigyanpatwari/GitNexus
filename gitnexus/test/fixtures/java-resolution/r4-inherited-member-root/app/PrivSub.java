package app;
class PrivSub extends PrivBase { void priv(models.User u) { u.save(); } }