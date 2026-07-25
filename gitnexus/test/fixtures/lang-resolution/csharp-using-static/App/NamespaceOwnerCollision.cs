namespace First
{
    public class NamespaceTwin
    {
        public void RejectOtherNamespaceOwner()
        {
            NamespaceCollision();
        }
    }
}

namespace Second
{
    public class NamespaceTwin
    {
        public void NamespaceCollision() { }
    }
}
