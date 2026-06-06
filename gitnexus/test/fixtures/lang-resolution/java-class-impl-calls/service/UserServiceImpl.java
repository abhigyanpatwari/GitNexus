package service;

/**
 * UserServiceImpl — concrete implementation. The IMPLEMENTS edge points
 * at UserService (interface). context(name="UserServiceImpl") should
 * surface the controller's method-level CALLS that hit interface methods.
 */
public class UserServiceImpl implements UserService {
    @Override
    public java.util.List<String> getUsers() {
        java.util.List<String> users = new java.util.ArrayList<>();
        return users;
    }

    @Override
    public String createUser(String name, String email) {
        return name + ":" + email;
    }
}
