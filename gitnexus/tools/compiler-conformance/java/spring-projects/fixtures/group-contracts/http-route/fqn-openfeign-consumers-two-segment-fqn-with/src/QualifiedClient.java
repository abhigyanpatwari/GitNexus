
@org.springframework.cloud.openfeign.FeignClient(name = "order-service", path = "/api")
interface QualifiedClient {
  @org.springframework.web.bind.annotation.GetMapping("/orders/{id}")
  OrderDto getOrder(String id);
}

@foo.RestController
@foo.RequestMapping("/v2")
class ShortFqnController {
  @foo.GetMapping("/items")
  Object items() { return null; }
}

@com.example.NotARoute("/should-not-extract")
class Unrelated {
  @com.example.AlsoNotARoute("/nope")
  Object noop() { return null; }
}
