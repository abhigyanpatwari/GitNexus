
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/api/v3")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
