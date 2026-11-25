package pair;
class Use { void go() { Api.run((user, other) -> { user.save(); other.audit(); }); } }