protocol Courier {
    func dispatch()
}
class StandardCourier: Courier {
    func dispatch() {}
}
class ExpressCourier: StandardCourier {
    override func dispatch() { super.dispatch() }
}
func send(contract: Courier, standard: StandardCourier, express: ExpressCourier) {
    contract.dispatch()
    standard.dispatch()
    express.dispatch()
}
class UnrelatedCourier {
    func dispatch() {}
    func use() { dispatch() }
}
let note = "dispatch" // dispatch remains documentation
