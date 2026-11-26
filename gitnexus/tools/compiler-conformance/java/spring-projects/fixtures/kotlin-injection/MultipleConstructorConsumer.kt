package com.example
import org.springframework.stereotype.Service
@Service
class MultipleConstructorConsumer(gateway: PaymentGateway) {
  constructor(repo: ConcreteRepo) : this(FastGateway())
}
