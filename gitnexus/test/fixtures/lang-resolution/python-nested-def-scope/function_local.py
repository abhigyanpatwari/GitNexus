def outer():
    def target(msg):
        return msg

    target("inner")


def caller():
    from facade import target

    target("caller")
