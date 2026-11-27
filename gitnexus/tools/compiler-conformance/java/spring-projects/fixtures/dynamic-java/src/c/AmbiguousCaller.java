package c;
        import a.*;
        import b.*;
        class AmbiguousCaller {
          void ambiguousLookup() { ctx.getBeans(Parent.class); }
        }