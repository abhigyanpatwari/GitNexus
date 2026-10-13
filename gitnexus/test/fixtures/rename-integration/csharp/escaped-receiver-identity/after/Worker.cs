class @Worker {
    public int ReadValue() { return 1; }
}
class Client {
    public int Run() {
        @Worker @worker = new @Worker();
        return @worker.ReadValue();
    }
}
