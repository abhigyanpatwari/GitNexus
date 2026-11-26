
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class UserController {
    @GetMapping(value = "/users")
    public List<User> list() { return service.findAll(); }
}
