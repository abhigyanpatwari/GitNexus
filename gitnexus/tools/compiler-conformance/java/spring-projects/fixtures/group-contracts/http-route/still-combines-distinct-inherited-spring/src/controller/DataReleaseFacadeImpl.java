
package com.example.controller;
import com.example.rest.DataReleaseApi;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/open")
public class DataReleaseFacadeImpl implements DataReleaseApi {
    @Override
    public Object query() { return null; }
}
