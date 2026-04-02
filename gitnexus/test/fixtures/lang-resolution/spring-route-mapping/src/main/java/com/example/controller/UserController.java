package com.example.controller;

import com.example.constants.ApiPaths;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(ApiPaths.API_PREFIX)
public class UserController {
  private static final String USERS = "/users";
  private static final String PROFILE = "/users/profile";

  @GetMapping(USERS)
  public String listUsers() {
    return "users";
  }

  @PostMapping(path = UserPaths.CREATE)
  public String createUser() {
    return "created";
  }

  @PatchMapping(PROFILE)
  public String updateProfile() {
    return "updated";
  }

  @RequestMapping(value = ApiPaths.SEARCH, method = RequestMethod.POST)
  public String searchUsers() {
    return "search";
  }

  @RequestMapping(path = com.example.constants.ApiPaths.FQCN, method = RequestMethod.PUT)
  public String fullyQualifiedUsers() {
    return "fqcn";
  }

  @GetMapping(BrokenPaths.MISSING)
  public String brokenUsers() {
    return "broken";
  }

  @RequestMapping(path = { "/users/array" }, method = RequestMethod.DELETE)
  public String arrayUsers() {
    return "array";
  }
}

class UserPaths {
  static final String CREATE = "/users/create";
}
