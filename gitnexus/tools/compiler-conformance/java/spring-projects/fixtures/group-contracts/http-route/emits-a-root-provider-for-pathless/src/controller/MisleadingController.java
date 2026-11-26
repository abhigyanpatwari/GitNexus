
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
public class MisleadingController {
    @GetMapping(produces = "application/json")
    public List<User> list() { return service.findAll(); }
}
