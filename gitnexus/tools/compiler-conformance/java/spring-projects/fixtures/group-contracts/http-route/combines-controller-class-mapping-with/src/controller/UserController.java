
package com.example.controller;
import com.example.rest.UserApi;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class UserController implements UserApi {
    @Override
    public Object listUsers() { return null; }
}
