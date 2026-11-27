
import java.net.URI;
import java.net.http.HttpRequest;
import okhttp3.Request;
import okhttp3.RequestBody;

class EmptyVerb {
  void run(RequestBody body) throws Exception {
    new Request.Builder().url("/api/okhttp-empty").method("", body).build();
    HttpRequest hc = HttpRequest.newBuilder().uri(URI.create("/api/hc-empty")).method("", body).build();
  }
}
