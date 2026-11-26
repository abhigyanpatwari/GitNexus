export class Animal { speak() {} }
export class Cat extends Animal { override speak() {} }
export function make(kind: string): Animal;
export function make(kind: "cat"): Cat;
export function make(kind: string) { return kind === "cat" ? new Cat() : new Animal(); }

function config(opts: { port: number }): void;
function config(opts: { host: string }): void;
function config(opts: object) {}

function on(event: "open", cb: () => void): void;
function on(event: "close", cb: (code: number) => void): void;
function on(event: string, cb: (...args: any[]) => void) {}

export function run(other: string) {
  const cat = make("cat");
  cat.speak();
  const animal = make(other);
  animal.speak();
  config({ port: 80 });
  config({ host: "local" });
  on("open", () => {});
  on("close", (code) => { void code; });
}
