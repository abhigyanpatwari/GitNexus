
package com.example.controller;
import com.example.rest.UserApi;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/users")
public class UserController implements UserApi {
    @Override
    public Object getUser() { return null; }
}
