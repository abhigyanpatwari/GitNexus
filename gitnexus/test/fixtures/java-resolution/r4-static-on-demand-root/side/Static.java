package side;
import static lib.Outer.*;
class Static { void pass(Sink s, Inner.User x) { s.take(x); } }