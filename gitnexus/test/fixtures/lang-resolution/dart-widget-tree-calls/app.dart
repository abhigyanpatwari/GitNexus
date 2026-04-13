import 'builders.dart';

// Named argument call: child: buildHeader()
// List literal calls: children: [buildBody(), buildFooter()]
dynamic buildPage() {
  return Column(
    child: buildHeader(),
    children: [buildBody(), buildFooter()],
  );
}
