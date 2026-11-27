package probe;
        public class Service {
          private Repo repo;
          public void runField(String u) { this.repo.save(u); this.repo.save(u); }
          public void runParam(Repo r, String u) { r.save(u); r.save(u); }
        }
