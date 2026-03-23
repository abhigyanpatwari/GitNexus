using Models;

namespace App;

public class AppService
{
    public void ProcessWithRecursivePattern(object obj)
    {
        if (obj is User { Name: "Alice" } u)
        {
            u.Save();
        }

        var result = obj switch
        {
            Repo { Name: "main" } r => r.Save(),
            _ => false
        };
    }
}
