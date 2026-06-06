package controller;

import service.UserService;

/**
 * UserController — Spring-style controller. Holds a field of interface
 * type and calls interface methods. The CALLS edge is created at the
 * interface-method level (D5 resolution). context() on UserServiceImpl
 * should expose this caller via the IMPLEMENTS walk.
 */
public class UserController {
    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    public java.util.List<String> listUsers() {
        return userService.getUsers();
    }

    public String register(String name, String email) {
        return userService.createUser(name, email);
    }
}
