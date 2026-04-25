using System.Collections.Generic;
using Models;

namespace Services;

public class Renderer
{
    private Dictionary<string, Widget> _widgets = new();

    public void RenderAll()
    {
        foreach (var w in _widgets.Values)
        {
            w.Render();
        }
    }
}
