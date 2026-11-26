
package com.example.rest;
import org.springframework.web.bind.annotation.*;

public interface UserApi {
    @GetMapping("/users")
    Object listUsers();
}
