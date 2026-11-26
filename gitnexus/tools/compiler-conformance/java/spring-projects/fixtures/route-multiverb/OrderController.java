package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class OrderController {
  @GetMapping("/orders") public Object list() { return null; }
  @PostMapping("/orders") public Object make() { return null; }
}
