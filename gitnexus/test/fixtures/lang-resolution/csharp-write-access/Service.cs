public class UserService {
    public void UpdateUser(User user) {
        user.Name = "Alice";
        user.Address = new Address();
    }
}
