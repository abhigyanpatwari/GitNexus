
@RestController
@RequestMapping("/api/v2")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }
}
