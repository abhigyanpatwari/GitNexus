public class App {
    // Two-step pure method chain: user.getAddress().save()
    public static void twoStepChain(User user) {
        user.getAddress().save();
    }

    // Three-step pure method chain: user.getAddress().getCity().getZipCode()
    public static void threeStepChain(User user) {
        user.getAddress().getCity().getZipCode();
    }

    // Mixed chain: method then field then method: user.getAddress().city.getZipCode()
    public static void mixedChain(User user) {
        user.getAddress().city.getZipCode();
    }
}
