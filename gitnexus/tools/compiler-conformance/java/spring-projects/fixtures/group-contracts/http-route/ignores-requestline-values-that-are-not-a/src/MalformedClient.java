
import feign.RequestLine;

interface MalformedClient {
  @RequestLine("not a request line at all")
  String noVerb();

  @RequestLine("GET relative/no/leading/slash")
  String noLeadingSlash();

  @RequestLine("FETCH /unknown-verb")
  String unknownVerb();
}
