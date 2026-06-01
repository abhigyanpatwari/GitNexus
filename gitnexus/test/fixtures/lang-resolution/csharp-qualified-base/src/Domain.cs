namespace App.Domain
{
    // Sibling-namespace base types. `Base` resolves to EXTENDS (Class kind);
    // `IFoo` / `IBar` resolve to IMPLEMENTS (Interface kind). Single definition
    // per name keeps the registry-primary base lookup unambiguous.
    public class Base
    {
        public virtual void Run() { }
    }

    public interface IFoo
    {
        void Foo();
    }

    public interface IBar
    {
        void Bar();
    }
}
