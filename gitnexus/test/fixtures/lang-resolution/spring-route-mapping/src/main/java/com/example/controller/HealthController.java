package com.example.controller;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
  @RequestMapping("/status")
  public String status() {
    return "ok";
  }

  @RequestMapping(path = "/health", method = RequestMethod.GET)
  public String health() {
    return "ok";
  }
}
