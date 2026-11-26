package com.example.aop;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.After;
import org.aspectj.lang.annotation.AfterReturning;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Before;

@Aspect
public class OrderAspect {
  @Around("execution(* com.example..OrderService.*(..))")
  public Object traceOrderOperations(ProceedingJoinPoint joinPoint) throws Throwable {
    return joinPoint.proceed();
  }

  @Before("@annotation(org.springframework.transaction.annotation.Transactional)")
  public void transactionalAnnotationAdvice() {}

  @Before("within(*Service)")
  public void simpleNameWithinAdvice() {}

  @Before("execution(* *Service.kotlinCachedOperation(..))")
  public void simpleNameExecutionAdvice() {}

  @Before("execution(public * com.example.service.SecuredOperations.interfaceSecuredOperation(..))")
  public void publicInterfaceAdvice() {}

  @Before("within(OrderService)")
  public void unresolvedSimpleTypeAdvice() {}

  @AfterReturning(
      pointcut = "execution(* com.example..OrderService.cachedOperation(..))",
      returning = "result")
  public void cachedReturnAdvice(Object result) {}

  @Before("namedOrderOperations()")
  public void unresolvedNamedAdvice() {}

  @Before("")
  public void emptyPointcutAdvice() {}

  @After("execution(* com.example..OrderService.*(..)) && args(orderId)")
  public void unresolvedCompoundAdvice(String orderId) {}
}
