
package com.example.rest;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/status")
public interface StatusApi {
    @GetMapping("")
    Object getStatus();
}
