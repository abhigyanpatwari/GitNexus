
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/api")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
