package com.example
import okhttp3.Request
import okhttp3.RequestBody

class OkPre(private val body: RequestBody) {
  fun run() {
    Request.Builder().post(body).url("/api/pre").build()
  }
}
