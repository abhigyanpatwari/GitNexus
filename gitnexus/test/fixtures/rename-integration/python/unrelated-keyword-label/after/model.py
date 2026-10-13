from dataclasses import dataclass

@dataclass
class Point:
    renamed: int

def configure(x):
    return x

class Runner:
    def run(self, x):
        return x

class Other:
    def __init__(self, x):
        self.value = x

configure(x=1)
Runner().run(x=2)
Other(x=3)
