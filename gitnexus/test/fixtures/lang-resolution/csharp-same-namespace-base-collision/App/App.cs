using Acme.Core;

namespace Acme.App
{
    public class App
    {
        public void Process()
        {
            var leaf = new Leaf();
            leaf.Greet().Save();
        }
    }
}
