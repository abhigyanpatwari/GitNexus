package com.example.app;

import com.example.models.*;

public class TypeOnly {
    @Audited
    public boolean check(Object value) throws BizException {
        return value instanceof User;
    }
}
