class Animal {
    speak() {
        throw new Error("Not implemented");
    }

    static classify(name) {
        return "mammal";
    }

    breathe() {
        return true;
    }
}

class Dog extends Animal {
    speak() {
        return "woof";
    }
}

module.exports = { Animal, Dog };
