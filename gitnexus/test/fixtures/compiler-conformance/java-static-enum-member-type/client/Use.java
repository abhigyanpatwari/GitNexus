package client;

import static impl.Level.*;
import src.*;

class Use {
    void ambiguous(EnumDesc.User user) { user.pay(); }
    void qualified(src.EnumDesc.User user) { user.pay(); }
}
