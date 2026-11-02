class Box:
    def target(self, msg):
        return msg


def method_function_caller():
    from facade import target

    target("caller")
