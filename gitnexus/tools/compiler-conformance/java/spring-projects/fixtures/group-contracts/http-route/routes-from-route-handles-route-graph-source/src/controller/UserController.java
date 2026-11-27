
@RestController
@RequestMapping("/api/v2")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }

    @PostMapping("/users")
    public User create(@RequestBody User user) { return service.save(user); }
}
