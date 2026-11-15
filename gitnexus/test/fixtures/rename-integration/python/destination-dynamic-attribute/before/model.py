class Worker:
    def target(self):
        return 7

def run():
    worker = Worker()
    setattr(worker, "renamed", 42)
    return worker.target()
