
package com.example.a;
import org.springframework.web.bind.annotation.*;

public interface StatusApi {
    @GetMapping("/a/status")
    Object getStatus();
}
