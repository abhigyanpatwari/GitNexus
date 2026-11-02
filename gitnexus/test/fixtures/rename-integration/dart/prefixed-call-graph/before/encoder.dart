String encode() { return "encode"; }
String middle() {
    var callback = encode;
    return callback() + encode();
}
String entry() { return middle(); }
String local(String encode) { return encode; }
// encode remains documentation
