import 'dart:async';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

// Top-level function
String greet(String name) {
  return 'Hello, $name!';
}

// Top-level typedef
typedef JsonMap = Map<String, dynamic>;
typedef Callback = void Function(int value);

// Enum
enum Status {
  active,
  inactive,
  pending;

  String get label => name.toUpperCase();
}

// Class with extends and implements
class Animal {
  final String name;

  Animal(this.name);

  String speak() => 'I am $name';
}

abstract class Describable {
  String describe();
}

class Dog extends Animal implements Describable {
  final String breed;

  Dog(super.name, this.breed);

  // Factory constructor
  factory Dog.unknown() {
    return Dog('Unknown', 'Mixed');
  }

  @override
  String speak() => 'Woof! I am $name';

  @override
  String describe() => 'Dog($name, $breed)';

  // Getter
  String get info => '$name - $breed';

  // Setter
  set nickname(String value) {
    print('Nickname set to $value');
  }
}

// Mixin
mixin Swimming {
  void swim() {
    print('Swimming!');
  }
}

mixin Flying {
  void fly() {
    print('Flying!');
  }
}

// Class with mixin
class Duck extends Animal with Swimming, Flying {
  Duck(super.name);
}

// Extension
extension StringExtension on String {
  String capitalize() {
    if (isEmpty) return this;
    return '${this[0].toUpperCase()}${substring(1)}';
  }
}

// Generic class
class Repository<T> {
  final List<T> _items = [];

  void add(T item) {
    _items.add(item);
  }

  T? findFirst(bool Function(T) predicate) {
    for (final item in _items) {
      if (predicate(item)) return item;
    }
    return null;
  }
}

// Private function (starts with _)
void _privateHelper() {
  print('I am private');
}

// Async function
Future<String> fetchData(String url) async {
  final response = await http.get(Uri.parse(url));
  return response.body;
}

// Top-level const
const String appName = 'MyApp';

void main() {
  final dog = Dog('Rex', 'German Shepherd');
  dog.speak();
  print(greet('World'));
}
