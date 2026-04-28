public class App {
    // Cross-file: calls overloaded methods defined in other files
    public void crossFileById() {
        DbLookup db = new DbLookup();
        db.find(42);
    }

    public void crossFileByName() {
        DbLookup db = new DbLookup();
        db.find("alice");
    }

    // Chain: result of one overloaded call feeds into another
    public void chainIntToFormat() {
        DbLookup db = new DbLookup();
        Formatter fmt = new Formatter();
        String result = db.find(42);
        fmt.format(result);
    }

    public void chainNameToFormat() {
        DbLookup db = new DbLookup();
        Formatter fmt = new Formatter();
        String result = db.find("alice");
        fmt.format(result);
    }
}
