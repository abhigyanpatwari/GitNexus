class Base
{
    protected void Inherited() { }
}

class Owner : Base
{
    private void Own() { }

    public void CallOwn()
    {
        Own();
    }

    public void CallInherited()
    {
        Inherited();
    }

    public void CallLocal()
    {
        void Local() { }
        Local();
    }
}

class Unrelated
{
    public void Collide() { }
}

class Caller
{
    public void Run()
    {
        Collide();
    }
}
