package com.example;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Before;

@Aspect public class TraceAspect {
  @Before("within(com.example.FirstService)") public void trace() {}
}
