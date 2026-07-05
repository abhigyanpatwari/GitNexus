import models.Core;
import models.Decoy;
import models.Engine;
import models.Mapper;
import models.Monitor;
import models.Report;
import models.ReportFactory;

public class App {
    private Engine engine;
    private Monitor monitor;
    private Mapper mapper;
    private Decoy decoy;
    private ReportFactory factory = new ReportFactory();

    // Field-initializer context (#2353 review F4): the chain runs outside
    // any method/constructor scope. Decoy.make is the decoy.
    private Report summary = this.factory.make();

    // Instance-initializer-block context (#2353 review F4): the chain runs
    // outside any method/constructor scope. Decoy.watch is the decoy.
    {
        this.monitor.watch();
    }

    // One-hop chain: this.engine → Engine, start() → Engine.start.
    // Decoy.start is the decoy.
    public void chainOneHop() {
        this.engine.start();
    }

    // Two-hop chain through two typed fields: this.engine → Engine,
    // .core → Core, ignite() → Core.ignite. Decoy.ignite is the decoy.
    public void chainTwoHop() {
        this.engine.core.ignite();
    }

    // Chain whose call argument contains a dot (#2353 review F5): the
    // receiver of run() is `this.mapper.lookup("a.b")` — the dot inside
    // the string argument must not break chain segmentation.
    // Decoy.run is the decoy.
    public void chainDottedArg() {
        this.mapper.lookup("a.b").run();
    }

    // Consistency guard: an identically-shaped parameter-receiver chain
    // (same classes) must resolve the same way as the this. variant —
    // no this-only special-casing in the resolver.
    public void chainOneHopParam(App obj) {
        obj.engine.start();
    }
}
