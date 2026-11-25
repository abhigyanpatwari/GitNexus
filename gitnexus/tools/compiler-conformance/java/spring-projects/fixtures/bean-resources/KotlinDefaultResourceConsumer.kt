package com.kotlin
import javax.annotation.Resource
class KotlinDefaultResourceConsumer {
  @field:Resource
  lateinit var kotlinGateway: KGateway
}
