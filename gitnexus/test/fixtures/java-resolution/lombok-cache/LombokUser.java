import lombok.Data;
@Data
class User {
  private String name;
}
class Consumer {
  String consume(User user) {
    return user.getName();
  }
}
