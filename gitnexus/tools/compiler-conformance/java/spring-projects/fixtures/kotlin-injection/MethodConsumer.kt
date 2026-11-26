package com.example
import javax.inject.Inject
import org.springframework.stereotype.Service
@Service
class MethodConsumer {
  @Inject fun setRepo(repo: ConcreteRepo) {}
}
