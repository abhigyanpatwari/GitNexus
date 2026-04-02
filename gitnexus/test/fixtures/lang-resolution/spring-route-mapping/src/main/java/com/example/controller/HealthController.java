package com.example.controller;

import static com.example.constants.HealthPaths.HEALTH;
import static com.example.constants.HealthPaths.STATUS;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
  @RequestMapping(STATUS)
  public String status() {
    return "ok";
  }

  @RequestMapping(path = HEALTH, method = RequestMethod.GET)
  public String health() {
    return "ok";
  }
}
