class Base:
    def target(self):
        return 7
class Child(Base):
    pass
class Other:
    def keep(self):
        return 1

child = Child()
other = Other()
child.target()
getattr(other, "target", None)
hasattr(other, "renamed")
setattr(other, "target", 2)
