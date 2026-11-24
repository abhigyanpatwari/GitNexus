package com.acme.named;

import static com.acme.lib.Constants.LIMIT;
import static com.acme.lib.Constants.Limit;
import static com.acme.lib.Constants.Token;

public class Named extends Token {
    public int read() { return LIMIT + Limit; }
}
