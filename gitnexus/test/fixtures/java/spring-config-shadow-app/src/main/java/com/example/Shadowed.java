package com.example;

import org.springframework.beans.factory.annotation.*;

class Shadowed {
  @Value("${fake.key}")
  private String fake;
}
