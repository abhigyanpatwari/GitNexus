
package com.example.b;
import org.springframework.web.bind.annotation.*;

public interface StatusApi {
    @GetMapping("/b/status")
    Object getStatus();
}
