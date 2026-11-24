package com.example;
import java.util.List;
import jakarta.annotation.Resource;
import org.springframework.beans.factory.annotation.Autowired;
public class ConflictingResourceConsumer {
  @Autowired @Resource List<Gateway> gateways;
}
