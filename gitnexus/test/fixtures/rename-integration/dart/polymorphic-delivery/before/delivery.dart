abstract class Courier {
    void dispatch();
}
class StandardCourier implements Courier {
    void dispatch() {}
}
class ExpressCourier extends StandardCourier {
    @override
    void dispatch() { super.dispatch(); }
}
void send(Courier contract, StandardCourier standard, ExpressCourier express) {
    contract.dispatch();
    standard.dispatch();
    express.dispatch();
}
class UnrelatedCourier {
    void dispatch() {}
    void use() { dispatch(); }
}
String note = "dispatch"; // dispatch remains documentation
