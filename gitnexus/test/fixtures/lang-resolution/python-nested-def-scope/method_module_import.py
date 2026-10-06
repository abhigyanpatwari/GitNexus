from facade import target


class Box:
    def target(self, msg):
        return msg


def method_module_caller():
    target("caller")
