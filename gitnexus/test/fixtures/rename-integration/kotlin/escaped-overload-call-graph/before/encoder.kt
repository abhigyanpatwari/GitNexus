fun `encode`(): String { return "encode" }
fun encode(value: Int): String { return "number" }
fun middle(): String {
    val callback: () -> String = ::encode
    return encode() + encode(7)
}
fun entry(): String { return middle() }
fun local(encode: String): String { return encode }
class OtherEncoder {
    fun encode(): String { return "other" }
    fun use(): String { return encode() }
}
// encode is documented, not renamed
fun referenceOnly(): () -> String {
    val callback: () -> String = ::encode
    return callback
}
