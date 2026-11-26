package api; import static api.PrivateHost.Holder.secret;
        public class PrivateHost { public static class Holder { private static void secret() {} }
          void privateImport() { secret(); } }