interface Courier {
    void dispatch();
}
class StandardCourier implements Courier {
    public void dispatch() {}
}
class ExpressCourier extends StandardCourier {
    @Override public void dispatch() { super.dispatch(); }
}
class Delivery {
    void send(Courier contract, StandardCourier standard, ExpressCourier express) {
        contract.dispatch();
        standard.dispatch();
        express.dispatch();
    }
    String note = "dispatch"; // dispatch remains documentation
}
class UnrelatedCourier {
    void dispatch() {}
    void use() { dispatch(); }
}
