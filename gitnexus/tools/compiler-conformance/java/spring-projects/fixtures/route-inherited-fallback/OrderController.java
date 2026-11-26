package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class OrderController implements OrderApi {
  @GetMapping("/direct") public Object direct() { return null; }
  public Object get(Long id) { return null; }
}
