namespace DeepFieldChain;

public class City
{
    public string ZipCode { get; set; }

    public string GetName()
    {
        return "city";
    }
}

public class Address
{
    public City City { get; set; }
    public string Street { get; set; }

    public void Save()
    {
        // persist address
    }
}

public class User
{
    public string Name { get; set; }
    public Address Address { get; set; }

    public string Greet()
    {
        return Name;
    }
}
