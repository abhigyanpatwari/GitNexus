namespace MyApp.Interfaces
{
    public interface IRepository
    {
        void Save();
        void Delete();
    }

    public interface ILogger
    {
        void Log(string message);
    }
}
