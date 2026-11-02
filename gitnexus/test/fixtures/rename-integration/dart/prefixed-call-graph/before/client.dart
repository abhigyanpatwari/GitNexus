import 'encoder.dart' as codec;
String render() {
    var callback = codec.encode;
    return codec.encode() + callback();
}
// codec.encode is documentation
