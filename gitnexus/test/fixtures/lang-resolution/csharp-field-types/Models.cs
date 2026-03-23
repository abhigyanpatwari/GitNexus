namespace FieldTypes;

public class Address
{
    public string City { get; set; }

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
