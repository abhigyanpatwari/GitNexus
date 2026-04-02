export abstract class Animal {
    abstract speak(): string;

    static classify(name: string): string {
        return "mammal";
    }

    breathe(): boolean {
        return true;
    }
}

export class Dog extends Animal {
    speak(): string {
        return "woof";
    }
}
