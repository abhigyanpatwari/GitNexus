from models import User as U, Repo as R

def main():
    u = U("alice")
    r = R("https://example.com")
    u.save()
    r.persist()
