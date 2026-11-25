
import org.springframework.web.service.annotation.HttpExchange;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.annotation.PostExchange;

@HttpExchange(url = "/items")
interface InventoryApi {
  @GetExchange(url = "/{id}")
  Item getItem(Integer id);

  @PostExchange("/search")
  Page<Item> search(ItemFilter query);
}
