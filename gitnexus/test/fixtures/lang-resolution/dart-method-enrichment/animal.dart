abstract class Animal {
  String speak();

  static String classify(String name) {
    return "mammal";
  }

  bool breathe() {
    return true;
  }
}

class Dog extends Animal {
  @override
  String speak() {
    return "woof";
  }
}
