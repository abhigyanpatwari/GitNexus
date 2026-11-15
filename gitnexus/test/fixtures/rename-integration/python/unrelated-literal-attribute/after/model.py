class Worker:
    def renamed(self):
        return 1
    def other_member(self):
        return 2

worker = Worker()
worker.renamed()
getattr(worker, "other_member")()
setattr(worker, "other_\x6dember", worker.other_member)
hasattr(worker, r"other_member")
hasattr(worker, u"other_\u006dember")
hasattr(worker, """other_member""")
delattr(worker, "other_" "member")
def inspect_unknown(receiver):
    return getattr(receiver, "other_member")
