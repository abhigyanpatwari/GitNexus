
package com.example.controller;
import com.example.rest.DataReleaseFacade;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/open/ai")
public class DataReleaseFacadeImpl extends BaseFacadeService implements DataReleaseFacade {
    @Override
    public Object query() { return null; }
}
