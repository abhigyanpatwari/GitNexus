class Animal { speak() {} }
class Dog extends Animal {
  fetchBall() {}
  static createBall() {}
  override speak() {}
}
export function inspect() {
  const exact: Animal = new Dog();
  exact.speak();
  exact.createBall();
  let mutable: Animal = new Dog();
  mutable = new Animal();
  mutable.fetchBall();
}
