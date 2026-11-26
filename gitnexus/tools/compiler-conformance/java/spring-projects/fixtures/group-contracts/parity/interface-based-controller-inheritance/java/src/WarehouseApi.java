
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.GetMapping;

@RequestMapping("/warehouses")
interface WarehouseApi {
  @GetMapping("/{id}/stock")
  Object listStock();
}
