def boot():
    global target

    def target():
        return "nested"


def caller():
    boot()
    target()
