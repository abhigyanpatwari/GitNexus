package com.example.aop

import org.aspectj.lang.annotation.Aspect as AopAspect
import org.aspectj.lang.annotation.Before as AdviceBefore

@AopAspect
object KotlinAliasedAspect {
  @AdviceBefore("@annotation(org.springframework.transaction.annotation.Transactional)")
  fun aliasedTransactionalAdvice() {}
}
