
import org.springframework.web.service.annotation.HttpExchange;
import org.springframework.web.service.annotation.GetExchange;

@HttpExchange(url = "/products")
interface ProductApi {
  @GetExchange("/{id}")
  Object get();
}
