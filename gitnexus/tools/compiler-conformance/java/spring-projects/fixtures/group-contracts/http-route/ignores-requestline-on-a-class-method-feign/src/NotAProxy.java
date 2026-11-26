
import feign.RequestLine;

class NotAProxy {
  @RequestLine("GET /should-not-extract")
  String call() { return null; }
}
