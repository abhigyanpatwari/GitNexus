package com.kotlin
import jakarta.annotation.Resource
class KotlinGenericResourceConsumer {
  @field:Resource
  lateinit var missingGateways: List<KGateway>
}
