from models import User as U, Repo as R


def main():
    u = U()
    u.save()

    r = R()
    r.persist()
