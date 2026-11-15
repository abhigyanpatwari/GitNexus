class Other:
    def target(self):
        return "unrelated"

    def leaked(self):
        return "also unrelated"


class Published:
    def published_ping(self):
        return "unrelated published class"


class ClassTarget:
    def class_ping(self):
        return "unrelated class target"
