package com.example.service;

import org.springframework.security.access.prepost.PreAuthorize;

public interface SecuredOperations {
  @PreAuthorize("hasRole('OPERATOR')")
  void interfaceSecuredOperation();
}
