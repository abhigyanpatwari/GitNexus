package com.example.shadow

import com.example.api.*

@RestController
class ShadowController {
    @GetMapping(ApiPaths.PETS)
    fun shadowed(): String = "must not become a route"
}
