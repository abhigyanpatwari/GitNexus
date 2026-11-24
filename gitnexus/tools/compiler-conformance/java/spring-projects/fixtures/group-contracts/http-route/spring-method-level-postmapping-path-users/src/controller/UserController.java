
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @PostMapping(path = "/users")
    public User create(@RequestBody User user) { return service.save(user); }
}
