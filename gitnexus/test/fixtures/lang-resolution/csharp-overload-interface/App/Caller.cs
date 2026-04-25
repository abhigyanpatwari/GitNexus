using Greeting;

namespace App;

public class Caller
{
    private Logger _logger = new();

    public string Run(IGreeter greeter)
    {
        _logger.Log("starting", 1);
        return greeter.Greet();
    }
}
