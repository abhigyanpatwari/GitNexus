import java.lang.annotation.ElementType;
          import java.lang.annotation.Target;
          @Target(ElementType.TYPE_USE) @interface Marker {}
          interface Named { String label(); }
          enum Status implements @Marker Named {
            ACTIVE;
            public String label() { return "active"; }
          }
          class Reader {
            String read(Named value) { return value.label(); }
          }