class Secret:
    def __read(self):
        return "__read"
    def reveal(self):
        return self.__read()
secret = Secret()
secret._Secret__read()
# __read has externally mangled spellings.
