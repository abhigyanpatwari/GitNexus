package service;

/**
 * UserService interface. The impl class (UserServiceImpl) implements this
 * interface, and UserController holds a field of this interface type and
 * calls getUsers()/createUser() on it. CALLS edges point at Method nodes
 * whose ownerId is THIS interface, not UserServiceImpl.
 */
public interface UserService {
    java.util.List<String> getUsers();
    String createUser(String name, String email);
}
