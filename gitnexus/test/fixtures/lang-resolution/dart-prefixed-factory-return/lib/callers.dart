import 'mod.dart' as rp;

int finalCall() {
  final x = rp.make();
  return x.m();
}

int varCall() {
  var x = rp.make();
  return x.m();
}

int inlineCall() => rp.make().m();

int untypedCall() {
  final x = rp.untyped();
  return x.m();
}

Future<int> awaitedCall() async {
  final x = await rp.makeAsync();
  return x.m();
}
