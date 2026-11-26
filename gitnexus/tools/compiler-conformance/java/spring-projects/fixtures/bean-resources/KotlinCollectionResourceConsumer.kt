package com.kotlin
import jakarta.annotation.Resource
class KotlinCollectionResourceConsumer {
  @set:Resource
  var kotlinList: List<KGateway>? = null
}
