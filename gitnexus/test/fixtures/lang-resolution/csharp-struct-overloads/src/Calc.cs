namespace Math;

public struct Calc
{
    public int Add(int a) { return a; }
    public int Add(int a, int b) { return a + b; }

    public void Run()
    {
        Add(1);
        Add(1, 2);
    }
}
