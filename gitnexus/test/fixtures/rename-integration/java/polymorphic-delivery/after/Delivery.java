interface Courier {
    void deliver();
}
class StandardCourier implements Courier {
    public void deliver() {}
}
class ExpressCourier extends StandardCourier {
    @Override public void deliver() { super.deliver(); }
}
class Delivery {
    void send(Courier contract, StandardCourier standard, ExpressCourier express) {
        contract.deliver();
        standard.deliver();
        express.deliver();
    }
    String note = "dispatch"; // dispatch remains documentation
}
class UnrelatedCourier {
    void dispatch() {}
    void use() { dispatch(); }
}
