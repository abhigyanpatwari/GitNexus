// On-disk path (Legacy/System/Threading/Tasks.cs) path-aligns with
// `using System.Threading.Tasks;` but declares an UNRELATED in-repo namespace,
// so the only way an IMPORTS edge forms is the coincidental path — which the
// gate must block in the no-csproj path on BOTH legs (#1881, Codex F2).
namespace MyApp.Legacy;

public class Tasks
{
    public void Run() { }
}
