from .services import bp as backplane

def combo_caller():
    return backplane.pf()
