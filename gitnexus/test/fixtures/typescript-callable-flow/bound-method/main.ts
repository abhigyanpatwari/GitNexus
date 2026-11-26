
class Worker {
  run(): void {}
}
class Decoy {
  run(): void {}
}
function invoke(callback: () => void): void { callback(); }
const worker = new Worker();
const assigned = worker.run;
invoke(assigned);
