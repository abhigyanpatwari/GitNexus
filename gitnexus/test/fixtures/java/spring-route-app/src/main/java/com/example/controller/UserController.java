package com.example.controller;

import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping("/list")
    public List<User> listUsers() {
        return null;
    }

    @PostMapping("/create")
    public User createUser() {
        return null;
    }

    @DeleteMapping(path = "/delete")
    public void deleteUser() {}

    @PutMapping(value = "/update")
    public void updateUser() {}
}
