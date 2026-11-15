class C:
    def m(self):
        return 1


class Other:
    def m(self):
        return 2


def make() -> C:
    return C()


def untyped():
    return C()
