import 'models.dart';

String wrap({String value = ''}) {
  return value;
}

String inReturn(Service svc) {
  return svc.compute();
}

List<String> inList(Service a, Service b) {
  return [a.first(), b.second()];
}

String inNamedArg(Service repo) {
  return wrap(value: repo.load());
}

String inArrow(Service svc) => svc.run();
