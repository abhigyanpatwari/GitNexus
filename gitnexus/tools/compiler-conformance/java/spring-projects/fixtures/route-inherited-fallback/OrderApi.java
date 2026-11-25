package com.example;
import org.springframework.web.bind.annotation.*;
@RequestMapping("/orders")
public interface OrderApi {
  @GetMapping("/{id}") Object get(Long id);
}
