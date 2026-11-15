import 'encoder.dart' as codec;
String render() {
    var callback = codec.serialize;
    return codec.serialize() + callback();
}
// codec.encode is documentation
