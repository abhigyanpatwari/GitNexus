package vendor;
import model.User;
public interface Callback<T> { void accept(User value); }