package models;

public class Shape {
    public void render() {
        // decoy: same-named method on expr's DECLARED type
    }

    public void draw() {
        // decoy: same-named method on the this.held field's DECLARED type
    }

    public void act4() {
        // decoy for ((java.util.List<Shape>) this.held2).act4(): an
        // unparseable cast that falls through to the held2 field's
        // declared type resolves here
    }
}
