namespace App
{
    // C# 12 primary constructor + base list (the #1951 worker-mode regression).
    public class User(int id) : BaseEntity, IFoo
    {
        public void Foo() { }
    }
}
