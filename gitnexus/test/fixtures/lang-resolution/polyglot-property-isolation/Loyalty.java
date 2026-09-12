// RV-5: the ONLY declaration of `loyaltyPointsBalance` in the workspace, and it
// is Java. Nothing in the JS file below can call into it.
package shop;

public class Loyalty {
    private int loyaltyPointsBalance;

    public int read() {
        return loyaltyPointsBalance;
    }
}
