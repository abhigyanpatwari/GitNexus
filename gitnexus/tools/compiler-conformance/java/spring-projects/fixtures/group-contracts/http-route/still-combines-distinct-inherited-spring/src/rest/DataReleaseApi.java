
package com.example.rest;
import org.springframework.web.bind.annotation.*;

@RequestMapping("/open/ai")
public interface DataReleaseApi {
    @GetMapping("/query")
    Object query();
}
