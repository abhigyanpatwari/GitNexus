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


def install_class():
    global Published

    class Published:
        def published_ping(self):
            return "global class"


def global_class_caller():
    install_class()
    published = Published()
    published.published_ping()


def class_global_boundary():
    class Inner:
        global retained

    def retained():
        return "function-local"

    retained()


def inverse_class_boundary_caller():
    retained()


class Installer:
    global class_target, ClassTarget

    def class_target(value):
        return value

    class ClassTarget:
        def class_ping(self):
            return "class-body global"


def class_global_caller():
    class_target(1)
    target = ClassTarget()
    target.class_ping()
