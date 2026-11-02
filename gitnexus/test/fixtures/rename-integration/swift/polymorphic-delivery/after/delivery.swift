protocol Courier {
    func deliver()
}
class StandardCourier: Courier {
    func deliver() {}
}
class ExpressCourier: StandardCourier {
    override func deliver() { super.deliver() }
}
func send(contract: Courier, standard: StandardCourier, express: ExpressCourier) {
    contract.deliver()
    standard.deliver()
    express.deliver()
}
class UnrelatedCourier {
    func dispatch() {}
    func use() { dispatch() }
}
let note = "dispatch" // dispatch remains documentation
