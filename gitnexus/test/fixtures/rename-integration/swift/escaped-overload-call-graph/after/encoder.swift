func `serialize`() -> String { return "encode" }
func serialize(value: Int) -> String { return "number" }
func middle() -> String {
    let callback: () -> String = serialize
    return serialize() + serialize(value: 7)
}
func entry() -> String { return middle() }
func local(encode: String) -> String { return encode }
class OtherEncoder {
    func encode() -> String { return "other" }
    func use() -> String { return encode() }
}
// encode remains documentation
