
import okhttp3.Request;
import okhttp3.RequestBody;

class OkPre {
  void run(RequestBody body) {
    new Request.Builder().post(body).url("/api/pre").build();
  }
}
