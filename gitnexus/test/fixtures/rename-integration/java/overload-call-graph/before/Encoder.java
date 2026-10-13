class Encoder {
    static String encode() { return "encode"; }
    static String encode(int value) { return "number"; }
    static String middle() { return encode() + encode(7); }
    static String entry() { return middle(); }
    static String local(String encode) { return encode; }
    // encode is named in the documentation
}
class OtherEncoder {
    static String encode() { return "other"; }
    static String entry() { return encode(); }
}
