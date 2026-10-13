class Base:
    def renamed(self):
        return 7
class Child(Base):
    pass
class Other:
    def keep(self):
        return 1

child = Child()
other = Other()
child.renamed()
getattr(other, "target", None)
hasattr(other, "renamed")
setattr(other, "target", 2)
