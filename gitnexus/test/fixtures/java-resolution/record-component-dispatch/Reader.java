class Reader {
          String read(Named value) { return value.name(); }
          java.util.List<String> directTags(User value) { return value.tags(); }
        }