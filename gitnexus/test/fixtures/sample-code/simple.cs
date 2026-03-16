using System;
using System.Collections.Generic;

namespace SampleApp
{
    public interface ICalculator
    {
        int Add(int a, int b);
    }

    public class Calculator : ICalculator
    {
        public int Result { get; private set; }

        public Calculator() { Result = 0; }

        public int Add(int a, int b)
        {
            Result = a + b;
            LogResult(Result);
            return Result;
        }

        private void LogResult(int value)
        {
            Console.WriteLine(value);
        }

        private int Multiply(int a, int b) { return a * b; }
    }

    internal class Helper
    {
        public void DoWork()
        {
            var calc = new Calculator();
            calc.Add(1, 2);
        }
    }

    public enum Operation
    {
        Add,
        Subtract,
        Multiply
    }

    public record CalculationResult(int Value, Operation Op);

    public struct Point
    {
        public int X { get; set; }
        public int Y { get; set; }
    }
}
