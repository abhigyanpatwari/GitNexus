
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.GetMapping;

@RestController
@RequestMapping({"/api/products"})
class ProductController {
  @GetMapping(path = {"/{id}"})
  Product get(Integer id) { return null; }
}
