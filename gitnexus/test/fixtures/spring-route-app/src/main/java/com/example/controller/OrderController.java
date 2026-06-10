package com.example.controller;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    @GetMapping("/list")
    public String listOrders() {
        return "[]";
    }

    @PostMapping("/submit")
    public String submitOrder() {
        return "{}";
    }
}
