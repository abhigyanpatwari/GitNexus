class Worker:
    def target(self):
        return 1
    def other_member(self):
        return 2

worker = Worker()
worker.target()
def dynamic(name):
    return getattr(worker, name)
