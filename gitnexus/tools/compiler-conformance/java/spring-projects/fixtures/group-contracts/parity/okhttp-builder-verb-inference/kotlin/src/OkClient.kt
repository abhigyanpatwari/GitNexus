package com.example
import okhttp3.Request
import okhttp3.RequestBody

class OkClient(private val body: RequestBody) {
  fun run() {
    Request.Builder().url("/api/things").post(body).build()
  }
}
