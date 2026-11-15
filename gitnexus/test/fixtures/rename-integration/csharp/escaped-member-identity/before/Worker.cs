class Worker { public int @Read() { return 7; } }
class Client { public int Run() { var @worker = new Worker(); return @worker.@Read(); } }
