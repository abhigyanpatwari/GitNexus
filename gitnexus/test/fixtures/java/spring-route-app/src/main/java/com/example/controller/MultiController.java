package com.example.controller;

import org.springframework.web.bind.annotation.*;

/**
 * Two controllers in one file — tests that class prefixes don't bleed.
 */
@RestController
@RequestMapping("/api/admin")
class AdminController {

    @GetMapping("/dashboard")
    public String dashboard() {
        return "admin";
    }

    @PatchMapping("/settings")
    public String updateSettings() {
        return "{}";
    }
}

@RestController
@RequestMapping("/api/public")
class PublicController {

    @GetMapping("/info")
    public String info() {
        return "public";
    }
}
