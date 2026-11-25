package app;
class Base { static class models { static class User { void save() {} } } }
class Sub extends Base { void inherited(models.User u) { u.save(); } }
class Plain { void unrelated(models.User u) { u.save(); } }
