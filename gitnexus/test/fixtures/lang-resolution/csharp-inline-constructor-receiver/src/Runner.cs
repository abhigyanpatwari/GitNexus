namespace App
{
    public class Runner
    {
        public int ViaInline()
        {
            return new Svc().DoWork();
        }

        public int ViaTwoStep()
        {
            var s = new Svc();
            return s.DoWork();
        }

        public int ViaFactory()
        {
            return Factories.MakeOther().DoWork();
        }
    }
}
