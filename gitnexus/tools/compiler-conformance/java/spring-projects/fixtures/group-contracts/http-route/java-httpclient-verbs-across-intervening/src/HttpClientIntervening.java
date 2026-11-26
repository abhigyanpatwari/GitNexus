
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpClient;
import java.time.Duration;

class HttpClientIntervening {
  void run(URI uriVar, Duration dur, HttpClient.Version ver, HttpRequest.BodyPublisher body) throws Exception {
    // Intervening calls AFTER .uri() — header/timeout transparent to the verb-walk.
    HttpRequest a = HttpRequest.newBuilder().uri(URI.create("/api/hdr")).header("Accept", "application/json").build();
    HttpRequest b = HttpRequest.newBuilder().uri(URI.create("/api/tmo")).timeout(dur).method("PUT", body).build();
    HttpRequest c = HttpRequest.newBuilder().uri(URI.create("/api/hdr-verb")).header("X", "y").DELETE().build();
    // Verb helper BEFORE an intervening call (walk does not stop at the first non-verb).
    HttpRequest d = HttpRequest.newBuilder().uri(URI.create("/api/verb-then-hdr")).POST(body).header("X", "y").build();
    // Unbuilt .uri() — no .build(); over-match emits the default GET (mirrors OkHttp).
    HttpRequest.Builder e = HttpRequest.newBuilder().uri(URI.create("/api/unbuilt"));
    // Call BEFORE .uri() and the constructor-arg form are now captured too (the
    // chain roots at HttpRequest.newBuilder); only a non-literal .uri() is a miss.
    HttpRequest f = HttpRequest.newBuilder().version(ver).uri(URI.create("/api/pre-uri")).build(); // call before .uri()
    HttpRequest g = HttpRequest.newBuilder(URI.create("/api/ctor")).build(); // constructor-arg, no .uri()
    HttpRequest h = HttpRequest.newBuilder().uri(uriVar).build(); // non-literal .uri() arg → miss
  }
}
