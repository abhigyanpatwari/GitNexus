package client;

import static api.ChildOuter.*;
import static api.Outer.*;

class Wildcard extends Inner.Base {
    int run() { return price(); }
}
