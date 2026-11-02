class Encoder {
    public static string @Serialize() { return "Encode"; }
    public static string Serialize(int value) { return "number"; }
    public static string Middle() {
        System.Func<string> callback = Serialize;
        return Serialize() + Serialize(7);
    }
    public static string Entry() { return Middle(); }
    public static string Local(string Encode) { return Encode; }
    public static string Named(string Encode) { return Encode; }
    public static string Label() { return Named(Encode: "literal"); }
    // Encode remains documentation
}
class OtherEncoder {
    public string Encode() { return "other"; }
    public string Use() { return Encode(); }
}
