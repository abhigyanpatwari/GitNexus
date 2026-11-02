func `encode`() -> String { return "encode" }
func encode(value: Int) -> String { return "number" }
func middle() -> String {
    let callback: () -> String = encode
    return encode() + encode(value: 7)
}
func entry() -> String { return middle() }
func local(encode: String) -> String { return encode }
class OtherEncoder {
    func encode() -> String { return "other" }
    func use() -> String { return encode() }
}
// encode remains documentation
