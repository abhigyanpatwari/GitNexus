package com.example.service

import org.springframework.transaction.annotation.Transactional

interface KotlinObjectContract {
  fun kotlinObjectInheritedTransaction()
  fun kotlinObjectExplicitTransaction()
}

@Transactional
object KotlinObjectService : KotlinObjectContract {
  override fun kotlinObjectInheritedTransaction() {}

  @Transactional
  override fun kotlinObjectExplicitTransaction() {}

  private fun kotlinObjectPrivateHelper() {}
}
