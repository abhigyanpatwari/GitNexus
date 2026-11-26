
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@FeignClient(name = "inventory-service")
@RequestMapping(path = "/api")
interface InventoryClient {
  @GetMapping("/inventory/{id}")
  InventoryDto getInventory(String id);
}
