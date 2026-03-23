namespace DeepFieldChain;

public class Service
{
    public static void ProcessUser(User user)
    {
        // 2-level chain: user.Address → Address, then .Save() → Address#Save
        user.Address.Save();

        // 3-level chain: user.Address → Address, .City → City, .GetName() → City#GetName
        user.Address.City.GetName();
    }
}
