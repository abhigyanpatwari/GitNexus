
import okhttp3.Request;
import okhttp3.RequestBody;

class OkHttpVerbs {
  void run(RequestBody body, String verb) {
    new Request.Builder().url("/api/orders/0").get().build();
    new Request.Builder().url("/api/orders/head").head().build();
    new Request.Builder().url("/api/orders").post(body).build();
    new Request.Builder().url("/api/orders/1").put(body).build();
    new Request.Builder().url("/api/orders/2").delete().build();
    new Request.Builder().url("/api/orders/3").method("PATCH", body).build();
    new Request.Builder().url("/api/bare-build").build();
    new Request.Builder().url("/api/dyn-verb").method(verb, body).build();
  }
}
