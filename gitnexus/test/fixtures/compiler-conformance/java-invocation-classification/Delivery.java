class Courier {
    void dispatch() {}
}

class Sender {
    void dispatch() {}
}

class Delivery extends Sender {
    @Override void dispatch() {}

    void send(Courier courier) {
        courier.dispatch();
        this.dispatch();
        super.dispatch();
        dispatch();
    }
}
