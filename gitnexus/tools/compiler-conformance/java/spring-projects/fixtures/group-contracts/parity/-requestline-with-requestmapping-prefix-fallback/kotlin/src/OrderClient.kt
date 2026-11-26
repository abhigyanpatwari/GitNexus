package com.example
import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.RequestMapping
import feign.RequestLine

@FeignClient(name = "order-service")
@RequestMapping("/orders")
interface OrderClient {
    @RequestLine("GET /{id}")
    fun get(): Any
}
