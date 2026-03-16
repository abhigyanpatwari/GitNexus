namespace Models;

public class Animal
{
    public string Name { get; set; }
}

public class Dog : Animal
{
    public void Bark()
    {
    }
}

public class Cat : Animal
{
    public void Meow()
    {
    }
}
