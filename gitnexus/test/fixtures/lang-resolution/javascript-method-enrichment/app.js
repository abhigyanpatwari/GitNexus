const { Animal, Dog } = require('./animal');

const dog = new Dog();
const sound = dog.speak();
const category = Animal.classify("dog");
