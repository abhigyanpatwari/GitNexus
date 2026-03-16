namespace MyApp.Models
{
    public class BaseEntity
    {
        public int Id { get; set; }

        public virtual void Validate()
        {
        }
    }
}
