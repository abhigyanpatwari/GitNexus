
import okhttp3.Request;
import okhttp3.RequestBody;

class OkHttpPreUrl {
  void run(RequestBody body, SomeClient other) {
    new Request.Builder().addHeader("A", "b").url("/api/pre-url").build();
    new Request.Builder().post(body).url("/api/verb-first").build();
    other.url("/api/not-okhttp").build();
  }
}
