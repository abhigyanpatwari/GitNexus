class Uniq { static class Solo { void run() {} } }
class Other2 { void run() {} }
class SameFile { void q4(Uniq.Solo value) { value.run(); } }
