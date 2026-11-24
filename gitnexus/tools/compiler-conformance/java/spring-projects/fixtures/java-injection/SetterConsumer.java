package com.example;
import org.springframework.stereotype.Service;
import jakarta.inject.Inject;
@Service
public class SetterConsumer {
  @Inject public void setRepo(ConcreteRepo repo) {}
}
