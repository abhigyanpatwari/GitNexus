class Worker:
    def target(self):
        return 1
    def other_member(self):
        return 2

worker = Worker()
worker.target()
getattr(worker, "tar\u0067et")()
