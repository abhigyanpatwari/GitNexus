package com.example.web

@RestController
class FirstDuplicateController {
    @GetMapping("/duplicate/first")
    fun list(): String = "first"
}

@RestController
class SecondDuplicateController {
    @GetMapping("/duplicate/second")
    fun list(id: String): String = id
}
