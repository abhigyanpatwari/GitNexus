
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @GetMapping(path = "/users")
    public List<User> list() { return service.findAll(); }
}
