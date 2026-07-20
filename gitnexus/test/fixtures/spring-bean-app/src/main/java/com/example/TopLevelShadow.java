package com.example;

import org.springframework.stereotype.Component;

@interface Component {}

@Component
class TopLevelShadowedComponent {}
