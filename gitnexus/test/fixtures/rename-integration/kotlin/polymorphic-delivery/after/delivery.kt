interface Courier {
    fun deliver()
}
open class StandardCourier : Courier {
    override fun deliver() {}
}
class ExpressCourier : StandardCourier() {
    override fun deliver() { super.deliver() }
}
fun send(contract: Courier, standard: StandardCourier, express: ExpressCourier) {
    contract.deliver()
    standard.deliver()
    express.deliver()
}
class UnrelatedCourier {
    fun dispatch() {}
    fun use() { dispatch() }
}
val note = "dispatch" // dispatch is documentation
