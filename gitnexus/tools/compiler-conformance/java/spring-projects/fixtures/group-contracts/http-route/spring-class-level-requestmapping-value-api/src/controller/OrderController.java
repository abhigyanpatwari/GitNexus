
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(value = "/orders")
public class OrderController {
    @GetMapping("/list")
    public List<Order> list() { return service.findAll(); }
}
