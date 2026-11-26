package com.example.service;

import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.security.access.annotation.Secured;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;

public class OrderService {
  @Transactional
  public void transactionalOperation() {}

  @Cacheable("orders")
  public String cachedOperation() { return "cached"; }

  @CacheEvict(cacheNames = "orders", allEntries = true)
  public void evictOperation() {}

  @PreAuthorize("hasRole('ADMIN')")
  public void securedOperation() {}

  @Secured("ROLE_AUDITOR")
  public void legacySecuredOperation() {}

  public void plainOperation() {}
}
