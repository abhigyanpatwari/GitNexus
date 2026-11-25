class Model {
    static class Field { Field() {} }
    static class Block { Block() {} }

    static Field field = new Field();
    { new Block(); }

    static class Copy {
        Field field = new Field();
        static { new Block(); }
    }
}
