interface Courier {
    fun dispatch()
}
open class StandardCourier : Courier {
    override fun dispatch() {}
}
class ExpressCourier : StandardCourier() {
    override fun dispatch() { super.dispatch() }
}
fun send(contract: Courier, standard: StandardCourier, express: ExpressCourier) {
    contract.dispatch()
    standard.dispatch()
    express.dispatch()
}
class UnrelatedCourier {
    fun dispatch() {}
    fun use() { dispatch() }
}
val note = "dispatch" // dispatch is documentation
