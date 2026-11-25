
package com.example.rest;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/departments")
public interface DepartmentApi {
    @GetMapping("")
    Object list();

    @GetMapping("/{name}")
    Object getByName(@PathVariable String name);
}
