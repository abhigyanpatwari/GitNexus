package com.acme.named;

import static com.acme.lib.Constants.LIMIT;
import static com.acme.lib.Constants.Limit;
import static com.acme.lib.Constants.Token;

/*
import com.acme.lib.CommentOnly;
*/
public class Named extends Token {
    private static final String EXAMPLE = """
        import com.acme.lib.TextOnly;
        """;
    public int read() { return LIMIT + Limit; }
}
