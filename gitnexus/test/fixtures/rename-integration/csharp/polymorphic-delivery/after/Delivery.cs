interface ICourier {
    void Deliver();
}
class StandardCourier : ICourier {
    public virtual void Deliver() {}
}
class ExpressCourier : StandardCourier {
    public override void Deliver() { base.Deliver(); }
}
class Delivery {
    public void Send(ICourier contract, StandardCourier standard, ExpressCourier express) {
        contract.Deliver();
        standard.Deliver();
        express.Deliver();
    }
    string note = "Dispatch"; // Dispatch remains documentation
}
class UnrelatedCourier {
    public void Dispatch() {}
    public void Use() { Dispatch(); }
}
