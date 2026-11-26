package com.example;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;

public class Consumer {
  @Autowired private List<IFoo> foos;
  private List<IFoo> plain;
}
