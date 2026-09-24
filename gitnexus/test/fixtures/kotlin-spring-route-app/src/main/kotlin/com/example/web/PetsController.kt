package com.example.web

import com.example.api.ApiPaths
import com.example.api.*

@RestController
@RequestMapping("/api")
class PetsController {
    companion object {
        const val OWN = "/own"
    }

    @GetMapping(ApiPaths.PETS)
    fun list(): String = "pets"

    @PostMapping(ApiPaths.BASE + "/items")
    fun create(): String = "item"

    @PutMapping(WILDCARD)
    fun wildcard(): String = "wild"

    @PatchMapping(OWN)
    fun own(): String = "own"

    @GetMapping(ApiPaths.ROOT)
    fun root(): String = "root"

    @DeleteMapping(ApiPaths.MISSING)
    fun missing(): String = "missing"
}

@RestController
@RequestMapping("/empty")
class EmptyController

class OrdinaryController {
    @GetMapping("/ordinary")
    fun ordinary() {}
}

@FeignClient(name = "remote")
interface RemoteClient {
    @GetMapping("/remote")
    fun remote()
}
