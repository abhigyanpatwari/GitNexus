package client; import static api.Explicit.pick;
        import static api.Explicit.shadow; import static api.Demand.*;
        class Imports { void importedPick() { pick("x"); }
          void importedShadow() { shadow("x"); } }