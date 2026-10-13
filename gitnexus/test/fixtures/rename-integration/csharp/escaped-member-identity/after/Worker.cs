class Worker { public int @Fetch() { return 7; } }
class Client { public int Run() { var @worker = new Worker(); return @worker.@Fetch(); } }
