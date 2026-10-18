from facade import target


def outer():
    def target(msg):
        return msg

    target("inner")


def caller():
    target("caller")
