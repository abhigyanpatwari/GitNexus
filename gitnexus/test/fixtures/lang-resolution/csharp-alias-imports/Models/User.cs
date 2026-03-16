namespace Models
{
    public class User
    {
        public string Name { get; }
        public User(string name) { Name = name; }
        public bool Save() => true;
    }
}
