package client;

import static java.lang.Math.*;
import static helpers.Utilities.*;

class StaticWildcards extends api.Base implements api.Signal {
    void run() {
        chosen();
        ping();
    }
}
