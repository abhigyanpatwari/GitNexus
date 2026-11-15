class @Worker {
    public int Read() { return 1; }
}
class Client {
    public int Run() {
        @Worker @worker = new @Worker();
        return @worker.Read();
    }
}
