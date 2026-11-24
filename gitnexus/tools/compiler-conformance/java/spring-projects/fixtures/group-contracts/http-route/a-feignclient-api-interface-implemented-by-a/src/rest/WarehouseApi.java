
package com.example.rest;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "catalog-service")
@RequestMapping("/warehouses")
public interface WarehouseApi {
    @GetMapping("/{id}/stock")
    Object listStock();
}
