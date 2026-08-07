package com.example.controller;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/legacy")
public class LegacyController {
    @RequestMapping("/all")
    public String allMethods() {
        return "all";
    }

    @RequestMapping(value = "/save", method = RequestMethod.POST)
    public String save() {
        return "saved";
    }

    @RequestMapping(path = "/inspect", method = {RequestMethod.GET, RequestMethod.HEAD})
    public String inspect() {
        return "inspected";
    }
}
