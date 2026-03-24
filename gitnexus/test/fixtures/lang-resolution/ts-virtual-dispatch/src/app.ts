// All classes in same file so parentMap captures the extends relationship

class Animal {
  speak(): string {
    return '...';
  }
}

class Dog extends Animal {
  speak(): string {
    return 'woof';
  }

  fetchBall(): string {
    return 'ball';
  }
}

export function run(): void {
  // Virtual dispatch: declared as Animal, constructed as Dog
  const animal: Animal = new Dog();
  animal.fetchBall();  // Only Dog has fetchBall — proves virtual dispatch override

  // Direct type: no override needed
  const dog: Dog = new Dog();
  dog.fetchBall();     // Direct resolution to Dog#fetchBall
}
