package probe;
        public class Runner {
          public boolean run(Validator<String> v) { return v.check("x"); }
          public <T> boolean runAny(Validator<T> v, T item) { return v.check(item); }
        }
