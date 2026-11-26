package com.example
import org.springframework.web.bind.annotation.RestController

@RestController
class WarehouseController : WarehouseApi {
    override fun listStock(): Any = TODO()
}
