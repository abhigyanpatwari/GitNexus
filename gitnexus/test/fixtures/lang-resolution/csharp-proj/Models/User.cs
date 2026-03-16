using MyApp.Interfaces;

namespace MyApp.Models
{
    public class User : BaseEntity, IRepository
    {
        public string Name { get; set; }

        public void Save()
        {
        }

        public void Delete()
        {
        }

        public override void Validate()
        {
        }
    }
}
