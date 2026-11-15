class Base:
    def target(self):
        return 7
class Child(Base):
    pass

worker = Child()
getattr(worker, "target")()
