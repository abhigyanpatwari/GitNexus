namespace Services;

using Models;

public class App
{
    public void Run()
    {
        var c = new Child();
        c.ParentMethod();
    }
}
