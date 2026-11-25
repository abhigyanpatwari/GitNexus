package com.example.aop

import org.aspectj.lang.annotation.Aspect
import org.aspectj.lang.annotation.Before

@Aspect
object KotlinOrderAspect {
  @Before("within(com.example.service.KotlinOrderService)")
  fun traceKotlinOperations() {}

  @Before("within(com.example.service.KotlinObjectService)")
  fun traceKotlinObjectOperations() {}

  @Before("""execution(* com.example..KotlinOrderService.kotlinCachedOperation(..))""")
  fun rawStringPointcutAdvice() {}
}
