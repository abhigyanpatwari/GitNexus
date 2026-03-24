import models as m
import auth as a

def main():
    u = m.User()
    u.save()

    r = m.Repo()
    r.persist()

    v = a.User()
    v.login()
