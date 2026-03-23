using NullCheck.Models;
using System;

namespace NullCheck.Services
{
    public class App
    {
        public App(User? x)
        {
            if (x != null)
            {
                x.Save();
            }
        }

        public void ProcessInequality(User x)
        {
            if (x != null)
            {
                x.Save();
            }
        }

        public void ProcessIsNotNull(User x)
        {
            if (x is not null)
            {
                x.Save();
            }
        }

        public void ProcessInLambda(User? x)
        {
            Action act = () =>
            {
                if (x != null)
                {
                    x.Save();
                }
            };
            act();
        }
    }
}
