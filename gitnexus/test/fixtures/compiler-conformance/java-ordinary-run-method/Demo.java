
class Worker {
  void run() {}
}
class Demo {
  static void entry() {
    Worker worker = new Worker();
    worker.run();
  }
}
