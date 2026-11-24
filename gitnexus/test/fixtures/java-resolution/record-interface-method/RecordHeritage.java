interface Named { String name(); }
          record User(String value) implements Named {
            public String name() { return value; }
          }
          class Reader {
            String read(Named value) { return value.name(); }
          }