class Box:
    def target(self, msg):
        return msg


def method_unbound_caller():
    target("caller")
