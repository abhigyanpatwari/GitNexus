namespace FieldTypes;

public class Service
{
    public static void ProcessUser(User user)
    {
        // Field-access chain: user.Address → Address, then .Save() → Address#Save
        user.Address.Save();
    }
}
