package com.example
import org.springframework.http.HttpMethod
import org.springframework.web.reactive.function.client.WebClient

class LongFormClient {
    fun run(webClient: WebClient) {
        webClient.method(HttpMethod.GET).uri("/api/items").retrieve()
    }
}
