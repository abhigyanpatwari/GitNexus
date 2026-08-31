import { describe, expect, it } from 'vitest';
import {
  extractCsharpViewComponentInvocations,
  extractRazorViewComponentInvocations,
  extractViewComponentAliasBinds,
  extractViewComponentAliases,
} from '../../../../src/core/ingestion/languages/csharp/razor-view-components.js';

describe('Razor ViewComponent convention extraction', () => {
  it('extracts literal InvokeAsync calls and ViewComponent tag helpers', () => {
    const source = `
      @await Component.InvokeAsync("SessionSummaryBar", new { id = 1 })
      @Component.InvokeAsync(
        "Navigation"
      )
      <vc:featured-product product-id="42" />
    `;

    expect(extractRazorViewComponentInvocations(source)).toEqual([
      'SessionSummaryBar',
      'Navigation',
      'FeaturedProduct',
    ]);
  });

  it('ignores Razor comments but keeps invocations inside HTML comments', () => {
    const source = `
      @* @await Component.InvokeAsync("RazorComment") *@
      <!-- @await Component.InvokeAsync("HtmlComment") -->
      <!-- <vc:session-summary-bar /> -->
      @await Component.InvokeAsync("Visible")
    `;

    expect(extractRazorViewComponentInvocations(source)).toEqual([
      'HtmlComment',
      'SessionSummaryBar',
      'Visible',
    ]);
  });

  it('does not treat plain markup text as an invocation', () => {
    expect(
      extractRazorViewComponentInvocations(
        `<p>Component.InvokeAsync("NotCode")</p><code>@Html.Partial("Card")</code>`,
      ),
    ).toEqual([]);
  });

  it('treats even @ runs as literals and odd leftover @ as a transition', () => {
    expect(
      extractRazorViewComponentInvocations(`
        @@await Component.InvokeAsync("Escaped")
        @@@await Component.InvokeAsync("OddTransition")
      `),
    ).toEqual(['OddTransition']);
  });

  it('extracts calls from Razor code islands and explicit expressions', () => {
    const source = `
      @{
        await Component.InvokeAsync("InBlock");
        // @await Component.InvokeAsync("CommentedInBlock")
        /* await Component.InvokeAsync("BlockComment") */
      }
      @if (true)
      {
        await Component.InvokeAsync("InIf");
      }
      @(await Component.InvokeAsync("Explicit"))
    `;
    expect(extractRazorViewComponentInvocations(source)).toEqual(['InBlock', 'InIf', 'Explicit']);
  });

  it('extracts in-repo C# helper calls without matching SDK Task.InvokeAsync', () => {
    const source = `
      await Component.InvokeAsync("SessionSummaryBar");
      return ViewComponent("AccountMenu");
      return this.ViewComponent("FromThis");
      return base.ViewComponent("FromBase");
      await this.Component.InvokeAsync("FromThisComponent");
      await Task.InvokeAsync("NotAComponent");
      renderer.ViewComponent("UnrelatedRenderer");
      await obj.Component.InvokeAsync("UnrelatedProperty");
    `;
    expect(extractCsharpViewComponentInvocations(source)).toEqual([
      'SessionSummaryBar',
      'AccountMenu',
      'FromThis',
      'FromBase',
      'FromThisComponent',
    ]);
  });

  it('does not treat string literals as helper invocations', () => {
    expect(
      extractCsharpViewComponentInvocations(`
        const string a = "ViewComponent(\\"DocsOnly\\")";
        const string b = @"ViewComponent(""Verbatim"")";
        const string c = """ViewComponent("Raw")""";
        return ViewComponent("Visible");
      `),
    ).toEqual(['Visible']);
  });

  it('does not treat positional ViewComponent attributes as helper invocations', () => {
    expect(
      extractCsharpViewComponentInvocations(`
        [ViewComponent("Alias")]
        public class MenuViewComponent : ViewComponent {}
      `),
    ).toEqual([]);
  });

  it('extracts named and qualified ViewComponent aliases', () => {
    const source = `
      [ViewComponent(Name = "AccountMenu")]
      public sealed class MenuViewComponent : ViewComponent {}

      [Microsoft.AspNetCore.Mvc.ViewComponentAttribute(Name = "Admin.Checkout")]
      internal class CheckoutWidget : ViewComponent {}
    `;
    expect(extractViewComponentAliases(source)).toEqual(
      new Map([
        ['MenuViewComponent', ['AccountMenu']],
        ['CheckoutWidget', ['Admin.Checkout']],
      ]),
    );
  });

  it('extracts aliases from combined attribute lists', () => {
    const source = `
      [ApiController, ViewComponent(Name = "AccountMenu")]
      public sealed class MenuViewComponent : ViewComponent {}
    `;
    expect(extractViewComponentAliases(source)).toEqual(
      new Map([['MenuViewComponent', ['AccountMenu']]]),
    );
  });

  it('extracts aliases from explicit record declarations', () => {
    const source = `
      [ViewComponent(Name = "AccountMenu")]
      public record class MenuViewComponent : ViewComponent {}

      [ViewComponent(Name = "Checkout")]
      internal record CheckoutWidget : ViewComponent {}
    `;
    expect(extractViewComponentAliases(source)).toEqual(
      new Map([
        ['MenuViewComponent', ['AccountMenu']],
        ['CheckoutWidget', ['Checkout']],
      ]),
    );
  });

  it('extracts aliases when comments sit between the attribute and the class', () => {
    const source = `
      [ViewComponent(Name = "AccountMenu")]
      // registered name overrides the suffix
      public class MenuViewComponent : ViewComponent {}

      [ViewComponent(Name = "Checkout")]
      /* other attrs */
      internal class CheckoutWidget : ViewComponent {}
    `;
    expect(extractViewComponentAliases(source)).toEqual(
      new Map([
        ['MenuViewComponent', ['AccountMenu']],
        ['CheckoutWidget', ['Checkout']],
      ]),
    );
  });

  it('does not treat positional constructor arguments as aliases', () => {
    expect(
      extractViewComponentAliases(`
        [ViewComponent("AccountMenu")]
        public class MenuViewComponent : ViewComponent {}
      `),
    ).toEqual(new Map());
  });

  it('binds aliases to the attributed class, not a same-named sibling', () => {
    const binds = extractViewComponentAliasBinds(`
      namespace A { [ViewComponent(Name = "AccountMenu")] class CardViewComponent {} }
      namespace B { class CardViewComponent {} }
    `);
    const attributed = binds.filter((bind) => bind.aliases.includes('AccountMenu'));
    expect(attributed).toHaveLength(1);
    expect(attributed[0]?.className).toBe('CardViewComponent');
    expect(binds.filter((bind) => bind.className === 'CardViewComponent')).toHaveLength(1);
  });

  it('ignores commented-out C# helper calls', () => {
    expect(
      extractCsharpViewComponentInvocations(`
        // return ViewComponent("Hidden");
        return ViewComponent("Visible");
      `),
    ).toEqual(['Visible']);
  });
});
