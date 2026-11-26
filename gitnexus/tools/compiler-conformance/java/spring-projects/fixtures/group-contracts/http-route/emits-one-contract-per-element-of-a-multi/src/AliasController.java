package com.example;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.GetMapping;

@RestController
@RequestMapping({"/base/one", "/base/two"})
public class AliasController {
    @GetMapping({"/primary", "/alias"})
    public Object get() { return null; }
}
