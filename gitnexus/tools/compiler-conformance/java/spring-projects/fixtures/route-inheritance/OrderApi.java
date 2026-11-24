package com.example;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/orders")
public interface OrderApi {
  @GetMapping("/list") Object list();
  @PostMapping("/create") Object create();
}
