using static ConsumerBeforeProvider.BProvider.UserFactory;

namespace ConsumerBeforeProvider.AConsumer
{
    public class Program
    {
        public void Run()
        {
            var u = GetUser();
            u.Save();
        }
    }
}
