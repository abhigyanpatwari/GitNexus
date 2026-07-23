using System;
using static App.SameFileStatics;

namespace App;

public static class SameFileStatics
{
    public static void ImportedOnly() { }

    public static string Select(string value, int count)
    {
        return value;
    }

    public static int Select(int value)
    {
        return value;
    }
}

public class SameFileIntruder
{
    public void LeakedOnly() { }

    public string Select(string value, int count)
    {
        return value;
    }
}

public class SameFileBase
{
    protected void InheritedOnly() { }
}

public class SameFileConsumer : SameFileBase
{
    private void OwnOnly() { }

    public void Exercise()
    {
        LeakedOnly();
        ImportedOnly();
        OwnOnly();
        InheritedOnly();
        Select("value", 1);

        int LocalOnly(int value)
        {
            return value;
        }

        Func<int> lambda = () => LocalOnly(2);
    }
}

public partial class SameFilePartial
{
    public void CallAcrossFragment()
    {
        AcrossFragment();
    }
}

public partial class SameFilePartial
{
    private void AcrossFragment() { }
}
