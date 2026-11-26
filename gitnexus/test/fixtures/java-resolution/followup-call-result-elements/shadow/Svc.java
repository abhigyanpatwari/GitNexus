package shadow;
public class Svc {
  private Repo repo;
  void run() { var xs = repo.findAll(); for (var x : xs) x.save(); }
}