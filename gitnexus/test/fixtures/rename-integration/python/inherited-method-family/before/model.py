class Base:
    def render(self):
        return "render"
class Child(Base):
    def render(self):
        return super().render()
class Other:
    def render(self):
        return "other"
def invoke(base: Base, child: Child, other: Other):
    return base.render() + child.render() + other.render()
value = Child()
value.render()
# render stays here.
