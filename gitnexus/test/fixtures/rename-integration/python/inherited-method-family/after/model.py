class Base:
    def paint(self):
        return "render"
class Child(Base):
    def paint(self):
        return super().paint()
class Other:
    def render(self):
        return "other"
def invoke(base: Base, child: Child, other: Other):
    return base.paint() + child.paint() + other.render()
value = Child()
value.paint()
# render stays here.
