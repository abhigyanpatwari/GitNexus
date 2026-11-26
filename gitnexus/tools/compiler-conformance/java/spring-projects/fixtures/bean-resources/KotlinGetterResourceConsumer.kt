package com.kotlin
import jakarta.annotation.Resource
class KotlinGetterResourceConsumer {
  @get:Resource
  var kotlinGateway: KGateway? = null
}
