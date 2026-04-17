import 'service.dart';

Future<void> run() async {
  final user = await fetchUser();
  await processData(user);
}
