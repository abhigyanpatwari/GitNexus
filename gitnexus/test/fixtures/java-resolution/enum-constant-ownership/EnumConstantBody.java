interface Named { String label(); }
          enum Status implements Named {
            ACTIVE { public String label() { return "active"; } },
            INACTIVE;
            public String label() { return "inactive"; }
          }
          class Reader {
            String read(Named value) { return value.label(); }
          }