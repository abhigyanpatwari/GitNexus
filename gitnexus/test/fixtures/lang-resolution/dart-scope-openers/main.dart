import 'models.dart';

// Untyped, so the bare `v` reads below name a real variable that types nothing.
var v;

User get u => User();
set u(User v) {
  v.save();
}

User get topGetter {
  final v = User();
  return v;
}

// Pinned recall gap: an accessor publishes no return binding, so the getter
// `u` (a `User`) types nothing here.
void topLevelBare() {
  u.save();
}

void commented(User v)
// the body is deliberately separated from its signature
{
  v.save();
}

void documented(User v)
/// a documentation comment separates this body from its signature
{
  v.save();
}

void commentedBare() {
  v.save();
}

class Factory {
  Other cs() => Other();
}

void moduleVarRebound(Address cs) {
  items.forEach((cs) => use(cs));
  cs.save();
}

class Box {
  var v;

  User get member => User();
  set member(User v) {
    v.save();
  }

  User get memberGetter {
    final v = User();
    return v;
  }

  // Pinned recall gap, as for `topLevelBare`.
  void memberBare() {
    member.save();
  }

  void memberLocalBare() {
    v.save();
  }
}
