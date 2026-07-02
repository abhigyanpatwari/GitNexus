package models;

public class Decoy {
    public void start() {
        // decoy: same-named method as Engine.start
    }

    public void ignite() {
        // decoy: same-named method as Core.ignite
    }

    public void watch() {
        // decoy: same-named method as Monitor.watch
    }

    public Report make() {
        // decoy: same-named method as ReportFactory.make
        return new Report();
    }

    public void run() {
        // decoy: same-named method as Result.run
    }
}
