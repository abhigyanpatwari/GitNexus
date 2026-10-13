String serialize() { return "encode"; }
String middle() {
    var callback = serialize;
    return callback() + serialize();
}
String entry() { return middle(); }
String local(String encode) { return encode; }
// encode remains documentation
