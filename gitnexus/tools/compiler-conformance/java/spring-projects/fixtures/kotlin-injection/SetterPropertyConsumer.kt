package com.example
import jakarta.inject.Inject
import org.springframework.stereotype.Service
@Service
class SetterPropertyConsumer {
  @set:Inject
  var repo: ConcreteRepo? = null
}
