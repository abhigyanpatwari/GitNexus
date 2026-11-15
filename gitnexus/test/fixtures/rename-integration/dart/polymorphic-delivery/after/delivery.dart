abstract class Courier {
    void deliver();
}
class StandardCourier implements Courier {
    void deliver() {}
}
class ExpressCourier extends StandardCourier {
    @override
    void deliver() { super.deliver(); }
}
void send(Courier contract, StandardCourier standard, ExpressCourier express) {
    contract.deliver();
    standard.deliver();
    express.deliver();
}
class UnrelatedCourier {
    void dispatch() {}
    void use() { dispatch(); }
}
String note = "dispatch"; // dispatch remains documentation
