package com.example.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class UserController {
  @GetMapping("/users")
  public String listUsers() {
    return "users";
  }

  @PostMapping(path = "/users/create")
  public String createUser() {
    return "created";
  }

  @PatchMapping("/users/profile")
  public String updateProfile() {
    return "updated";
  }
}
