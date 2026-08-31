import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './resolvers/helpers.js';

describe('C# Razor ViewComponent conventions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-csharp-razor-vc-'));
  let result: PipelineResult;

  beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));

  beforeAll(async () => {
    writeFixtureRepo(root, {
      'Components/SessionSummaryBarViewComponent.cs': `
        namespace Demo.Components;
        public class SessionSummaryBarViewComponent : ViewComponent
        {
          public object Invoke() => new object();
        }
      `,
      'Components/MenuViewComponent.cs': `
        namespace Demo.Components;
        [ApiController, ViewComponent(Name = "AccountMenu")]
        public class MenuViewComponent : ViewComponent
        {
          public object Invoke() => new object();
        }
      `,
      'One/DuplicateViewComponent.cs': `
        namespace Demo.One;
        public class DuplicateViewComponent : ViewComponent {}
      `,
      'Two/DuplicateViewComponent.cs': `
        namespace Demo.Two;
        public class DuplicateViewComponent : ViewComponent {}
      `,
      'Views/Home/Index.cshtml': `
        @await Component.InvokeAsync("SessionSummaryBar", new { id = 1 })
        <vc:account-menu />
        @{
          await Component.InvokeAsync("SessionSummaryBar");
        }
        @@await Component.InvokeAsync("SessionSummaryBar")
        <!-- @await Component.InvokeAsync("AccountMenu") -->
      `,
      'Views/Shared/Alias.cshtml': `@await Component.InvokeAsync("AccountMenu")`,
      'Views/Shared/Ambiguous.cshtml': `@await Component.InvokeAsync("Duplicate")`,
      'Views/Shared/Commented.cshtml': `
        @* @await Component.InvokeAsync("SessionSummaryBar") *@
      `,
      'Views/Shared/Suffix.cshtml': `@await Component.InvokeAsync("Menu")`,
      'Controllers/HomeController.cs': `
        using Microsoft.AspNetCore.Mvc;
        namespace Demo.Controllers;
        public class HomeController : Controller
        {
          public IViewComponentResult Widget() => ViewComponent("SessionSummaryBar");
          public IViewComponentResult FromBase() => base.ViewComponent("SessionSummaryBar");
          public IViewComponentResult FromThis() => this.ViewComponent("SessionSummaryBar");
        }
      `,
    });
    result = await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true });
  }, 120000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('emits File-to-Class CALLS for literal and tag-helper invocations', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.rel.reason === 'aspnet-razor-view-component',
    );

    expect(
      calls
        .map((edge) => ({
          source: edge.sourceFilePath,
          target: edge.target,
          targetLabel: edge.targetLabel,
        }))
        .sort((a, b) => `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`)),
    ).toEqual([
      {
        source: 'Controllers/HomeController.cs',
        target: 'SessionSummaryBarViewComponent',
        targetLabel: 'Class',
      },
      {
        source: 'Views/Home/Index.cshtml',
        target: 'MenuViewComponent',
        targetLabel: 'Class',
      },
      {
        source: 'Views/Home/Index.cshtml',
        target: 'SessionSummaryBarViewComponent',
        targetLabel: 'Class',
      },
      {
        source: 'Views/Shared/Alias.cshtml',
        target: 'MenuViewComponent',
        targetLabel: 'Class',
      },
    ]);
    expect(calls.some((edge) => edge.target === 'ViewComponent')).toBe(false);
    expect(calls.some((edge) => edge.target === 'InvokeAsync')).toBe(false);
    expect(calls.some((edge) => edge.sourceFilePath === 'Components/MenuViewComponent.cs')).toBe(
      false,
    );
  });

  it('fails closed for ambiguous names, Razor comments, and replaced suffixes', () => {
    const razorSources = getRelationships(result, 'CALLS')
      .filter((edge) => edge.rel.reason === 'aspnet-razor-view-component')
      .map((edge) => edge.sourceFilePath);

    expect(razorSources).not.toContain('Views/Shared/Ambiguous.cshtml');
    expect(razorSources).not.toContain('Views/Shared/Commented.cshtml');
    expect(razorSources).not.toContain('Views/Shared/Suffix.cshtml');
  });
});
