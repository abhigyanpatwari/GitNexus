fun callExternal() {
    println("data")
}

val handler = object {
    fun println(msg: String) {
        System.out.println("wrapped: $msg")
    }
}
