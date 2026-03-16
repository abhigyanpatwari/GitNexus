namespace Models;

// C# 12 primary constructor
public class User(string name, int age)
{
    public string Name => name;
    public int Age => age;

    public void Save() { }
}
