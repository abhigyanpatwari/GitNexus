package com.example.service

import org.springframework.cache.annotation.CacheEvict
import org.springframework.cache.annotation.Cacheable
import org.springframework.cache.annotation.CachePut
import org.springframework.cache.annotation.Caching
import org.springframework.security.access.annotation.Secured
import org.springframework.security.access.prepost.PostAuthorize
import org.springframework.security.access.prepost.PostFilter
import org.springframework.security.access.prepost.PreAuthorize
import org.springframework.security.access.prepost.PreFilter
import org.springframework.transaction.annotation.Transactional

class KotlinOrderService {
  @Transactional
  fun kotlinTransactionalOperation() {}

  @Cacheable("orders")
  fun kotlinCachedOperation(): String = "cached"

  @CacheEvict(cacheNames = ["orders"], allEntries = true)
  fun kotlinEvictOperation() {}

  @PreAuthorize("hasRole('ADMIN')")
  fun kotlinSecuredOperation() {}

  @Secured("ROLE_AUDITOR")
  fun kotlinLegacySecuredOperation() {}

  @CachePut("orders")
  fun kotlinCachePutOperation() {}

  @Caching(cacheable = [Cacheable("orders")])
  fun kotlinCachingOperation() {}

  @PostAuthorize("returnObject != null")
  fun kotlinPostAuthorizeOperation(): String = "ok"

  @PreFilter("filterObject != null")
  fun kotlinPreFilterOperation(values: List<String>) {}

  @PostFilter("filterObject != null")
  fun kotlinPostFilterOperation(): List<String> = emptyList()

  @jakarta.annotation.security.RolesAllowed("ADMIN")
  fun kotlinJakartaRolesAllowedOperation() {}

  @javax.annotation.security.RolesAllowed("AUDITOR")
  fun kotlinJavaxRolesAllowedOperation() {}

  @jakarta.transaction.Transactional
  fun kotlinJakartaTransaction() {}

  @javax.transaction.Transactional
  fun kotlinJavaxTransaction() {}

  @Transactional
  suspend fun kotlinSuspendTransaction() {}

  @Transactional
  fun String.kotlinExtensionTransaction() {}

  @org.springframework.transaction.annotation.Transactional
  fun kotlinFullyQualifiedTransaction() {}

  @Transactional
  private fun kotlinPrivateTransaction() {}
}

@Transactional
fun kotlinTopLevelTransaction() {}
