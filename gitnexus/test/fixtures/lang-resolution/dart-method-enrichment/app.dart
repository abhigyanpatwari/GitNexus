import 'animal.dart';

void main() {
  var dog = Dog();
  var sound = dog.speak();
  var category = Animal.classify("dog");
}
