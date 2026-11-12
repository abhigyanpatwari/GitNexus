import 'models.dart';

set u(User v) {
  v.save();
}

User get topGetter {
  final v = User();
  return v;
}

void topLevelBare() {
  u.save();
}

void commented(User v)
// the body is deliberately separated from its signature
{
  v.save();
}

void commentedBare() {
  v.save();
}

Other cs = Other();
void moduleVarRebound(Address cs) {
  items.forEach((cs) => use(cs));
  cs.save();
}

class Box {
  set member(User v) {
    v.save();
  }

  User get memberGetter {
    final v = User();
    return v;
  }

  void memberBare() {
    member.save();
  }

  void memberLocalBare() {
    v.save();
  }
}
