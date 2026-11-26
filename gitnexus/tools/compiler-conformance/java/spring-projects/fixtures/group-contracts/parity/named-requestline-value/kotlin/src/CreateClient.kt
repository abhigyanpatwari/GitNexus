package com.example
import org.springframework.cloud.openfeign.FeignClient
import feign.RequestLine

@FeignClient(name = "create-service")
interface CreateClient {
    @RequestLine(value = "POST /create")
    fun create(): Any
}
