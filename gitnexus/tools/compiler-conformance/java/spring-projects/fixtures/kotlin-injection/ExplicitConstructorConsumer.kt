package com.example
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.stereotype.Service
@Service
class ExplicitConstructorConsumer() {
  @Autowired constructor(repo: ConcreteRepo) : this()
}
