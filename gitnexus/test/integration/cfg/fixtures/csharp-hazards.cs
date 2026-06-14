// C# CFG hazard fixture (#2195 U3). Exercises every control-flow construct the
// csharp CfgVisitor models, so the worker-mode pipeline produces non-trivial
// BasicBlock / CFG / REACHING_DEF / CDG counts (and so the byte-identical-off
// golden gate has real shapes to compare). Mirrors c-hazards.c / cpp-hazards.cpp.

using System;
using System.Collections.Generic;

namespace Hazards
{
    public class Demo
    {
        // if / else-if / else.
        public int Classify(int x)
        {
            if (x > 0)
            {
                return 1;
            }
            else if (x < 0)
            {
                return -1;
            }
            else
            {
                return 0;
            }
        }

        // for, foreach, while, do-while + break / continue.
        public int Loops(int[] xs, int n)
        {
            int total = 0;
            for (int i = 0; i < n; i++)
            {
                if (i == 3) { continue; }
                total += i;
            }
            foreach (var x in xs)
            {
                if (x < 0) { break; }
                total += x;
            }
            int j = 0;
            while (j < n)
            {
                total += j;
                j++;
            }
            do
            {
                total -= 1;
            } while (total > 100);
            return total;
        }

        // switch_statement with fallthrough-empty section + default.
        public string Name(int code)
        {
            switch (code)
            {
                case 1:
                case 2:
                    return "low";
                case 3:
                    return "three";
                default:
                    return "other";
            }
        }

        // switch_expression arms.
        public int Score(int grade) => grade switch
        {
            1 => 100,
            2 => 80,
            _ => 0,
        };

        // try / catch / finally with a return crossing the finally.
        public int Guarded(int x)
        {
            try
            {
                if (x < 0) { throw new ArgumentException(nameof(x)); }
                return Compute(x);
            }
            catch (ArgumentException e)
            {
                Log(e);
                return -1;
            }
            finally
            {
                Cleanup();
            }
        }

        // using (deterministic dispose on both normal and exception exit).
        public int ReadAll(string path)
        {
            using (var reader = Open(path))
            {
                return reader.Read();
            }
        }

        // lock (monitor release finalizer).
        private readonly object _sync = new object();
        public void Touch(int v)
        {
            lock (_sync)
            {
                _value += v;
            }
        }

        // goto / labeled statement.
        public int Retry(int limit)
        {
            int attempts = 0;
        start:
            attempts++;
            if (attempts < limit) { goto start; }
            return attempts;
        }

        // yield iterator (state-machine limitation documented; surface flow only).
        public IEnumerable<int> Take(int[] src, int count)
        {
            int taken = 0;
            foreach (var item in src)
            {
                if (taken >= count) { yield break; }
                taken++;
                yield return item;
            }
        }

        // null-coalescing may-def + local function.
        public int Resolve(string s)
        {
            int Parse(string v) => int.Parse(v);
            string chosen = s ?? (s = "0");
            return Parse(chosen);
        }

        private int _value;
        private int Compute(int x) => x * 2;
        private static void Log(Exception e) { }
        private void Cleanup() { }
        private Reader Open(string path) => new Reader();
    }

    public class Reader
    {
        public int Read() => 0;
    }
}
