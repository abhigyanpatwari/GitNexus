
package com.example.controller;
import com.example.rest.WarehouseApi;
import org.springframework.web.bind.annotation.*;

@RestController
public class WarehouseController implements WarehouseApi {
    @Override
    public Object listStock() { return null; }
}
