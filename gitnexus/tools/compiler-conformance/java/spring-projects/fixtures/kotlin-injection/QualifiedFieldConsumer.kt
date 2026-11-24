package com.example
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
@Service
class QualifiedFieldConsumer {
  @field:Autowired
  @field:Qualifier("slowGateway")
  lateinit var gateway: PaymentGateway
}
