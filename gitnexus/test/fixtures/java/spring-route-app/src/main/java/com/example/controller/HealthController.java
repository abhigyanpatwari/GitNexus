package com.example.controller;

import org.springframework.web.bind.annotation.*;

/**
 * Controller without class-level @RequestMapping — routes should be bare paths.
 */
@RestController
public class HealthController {

    @GetMapping("/health")
    public String health() {
        return "OK";
    }

    @GetMapping("/ready")
    public String ready() {
        return "OK";
    }
}
