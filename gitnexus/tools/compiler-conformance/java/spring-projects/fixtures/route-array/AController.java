package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class AController {
  @GetMapping("/covered") public Object covered() { return null; }
  @GetMapping({"/a","/b"}) public Object multi() { return null; }
}
