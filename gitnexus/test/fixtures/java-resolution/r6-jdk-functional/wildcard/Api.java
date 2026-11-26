package wildcard;
import java.util.function.Consumer;
import model.User;
public class Api { public static void run(Consumer<? extends User> callback) {} }