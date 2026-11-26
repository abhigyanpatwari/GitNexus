package com.example.service

import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.transaction.annotation.Transactional

@Transactional
interface KotlinTransactionalOperations {
  fun kotlinInterfaceInheritedTransaction()

  @PreAuthorize("hasRole('KOTLIN_OPERATOR')")
  fun kotlinInterfaceSecuredOperation()
}

interface KotlinMethodAnnotatedOperations {
  @Transactional
  fun kotlinInterfaceExplicitTransaction()
}

class KotlinTransactionalOperationsImpl : KotlinTransactionalOperations {
  override fun kotlinInterfaceInheritedTransaction() {}
  override fun kotlinInterfaceSecuredOperation() {}
}

class KotlinMethodAnnotatedOperationsImpl : KotlinMethodAnnotatedOperations {
  override fun kotlinInterfaceExplicitTransaction() {}
}

open class KotlinBehaviorBase {
  @Transactional
  open fun kotlinOverriddenTransaction() {}
}

class KotlinBehaviorService : KotlinBehaviorBase() {
  override fun kotlinOverriddenTransaction() {}
}
