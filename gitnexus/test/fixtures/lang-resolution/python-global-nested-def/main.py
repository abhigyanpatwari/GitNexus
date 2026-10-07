def boot():
    global target

    def target():
        return "nested"


def caller():
    boot()
    target()


def outer():
    global leaked

    class Inner:
        def leaked(self):
            return "class-local"


def class_boundary_caller():
    leaked()
