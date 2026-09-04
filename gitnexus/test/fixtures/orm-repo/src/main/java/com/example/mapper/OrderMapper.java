package com.example.mapper;

import com.example.model.Order;
import org.apache.ibatis.annotations.Param;
import java.util.List;

public interface OrderMapper {
    Order selectByPrimaryKey(Long id);
    List<Order> selectByUserId(@Param("userId") Long userId);
    int insert(Order order);
    int updateStatus(@Param("id") Long id, @Param("status") Integer status);
    int deleteById(Long id);
}
