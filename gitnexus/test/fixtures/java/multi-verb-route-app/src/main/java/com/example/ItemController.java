package com.example;

import org.springframework.web.bind.annotation.*;

/**
 * Multi-verb route identity fixture (#2289).
 *
 *  - GET /api/items  and  POST /api/items  share a URL but are distinct
 *    declarative routes → two Route nodes keyed `(method, url)`.
 *  - GET /api/widgets overlaps a Next.js filesystem route at the same URL →
 *    a method-keyed node coexisting with the URL-only filesystem node.
 */
@RestController
@RequestMapping("/api")
public class ItemController {

    @GetMapping("/items")
    public String listItems() {
        return "[]";
    }

    @PostMapping("/items")
    public String createItem() {
        return "ok";
    }

    @GetMapping("/widgets")
    public String getWidgets() {
        return "[]";
    }
}
