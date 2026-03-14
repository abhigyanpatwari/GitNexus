using Models;

namespace Services;

public class AnimalService
{
    public void HandleAnimal(Animal animal)
    {
        if (animal is Dog dog)
        {
            dog.Bark();
        }
    }
}
