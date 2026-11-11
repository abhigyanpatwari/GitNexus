import 'mod.dart' deferred as dp;

int deferredFinalCall() {
  final x = dp.make();
  return x.m();
}

int deferredInlineCall() => dp.make().m();
