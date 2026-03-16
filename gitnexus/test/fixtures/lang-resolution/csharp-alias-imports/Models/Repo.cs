namespace Models
{
    public class Repo
    {
        public string Url { get; }
        public Repo(string url) { Url = url; }
        public bool Persist() => true;
    }
}
