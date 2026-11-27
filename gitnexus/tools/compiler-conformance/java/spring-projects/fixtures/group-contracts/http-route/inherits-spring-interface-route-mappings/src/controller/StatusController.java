
package com.example.controller;
import com.example.rest.StatusApi;
import org.springframework.web.bind.annotation.*;

@RestController
public class StatusController implements StatusApi {
    @Override
    public Object getStatus() { return null; }
}
