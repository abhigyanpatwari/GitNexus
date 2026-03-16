using Utils;

namespace App {
    public class Main {
        // Local method shadows imported Logger.Save
        public static void Save(string data) {
            System.Console.WriteLine("local save: " + data);
        }

        public static void Run() {
            Save("test");
        }
    }
}
