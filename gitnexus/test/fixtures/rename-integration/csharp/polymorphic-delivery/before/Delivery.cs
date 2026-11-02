interface ICourier {
    void Dispatch();
}
class StandardCourier : ICourier {
    public virtual void Dispatch() {}
}
class ExpressCourier : StandardCourier {
    public override void Dispatch() { base.Dispatch(); }
}
class Delivery {
    public void Send(ICourier contract, StandardCourier standard, ExpressCourier express) {
        contract.Dispatch();
        standard.Dispatch();
        express.Dispatch();
    }
    string note = "Dispatch"; // Dispatch remains documentation
}
class UnrelatedCourier {
    public void Dispatch() {}
    public void Use() { Dispatch(); }
}
