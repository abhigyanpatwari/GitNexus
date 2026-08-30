import { describe, expect, it } from 'vitest';
import {
  extractCsharpViewComponentInvocations,
  extractRazorViewComponentInvocations,
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

  it('ignores invocations inside Razor and HTML comments', () => {
    const source = `
      @* @await Component.InvokeAsync("RazorComment") *@
      <!-- @await Component.InvokeAsync("HtmlComment") -->
      @await Component.InvokeAsync("Visible")
    `;

    expect(extractRazorViewComponentInvocations(source)).toEqual(['Visible']);
  });

  it('does not treat plain markup text as an invocation', () => {
    expect(
      extractRazorViewComponentInvocations(
        `<p>Component.InvokeAsync("NotCode")</p><code>@Html.Partial("Card")</code>`,
      ),
    ).toEqual([]);
  });

  it('extracts in-repo C# helper calls without matching SDK Task.InvokeAsync', () => {
    const source = `
      await Component.InvokeAsync("SessionSummaryBar");
      return ViewComponent("AccountMenu");
      await Task.InvokeAsync("NotAComponent");
    `;
    expect(extractCsharpViewComponentInvocations(source)).toEqual([
      'SessionSummaryBar',
      'AccountMenu',
    ]);
  });

  it('extracts positional, named, and qualified ViewComponent aliases', () => {
    const source = `
      [ViewComponent(Name = "AccountMenu")]
      public sealed class MenuViewComponent : ViewComponent {}

      [Microsoft.AspNetCore.Mvc.ViewComponentAttribute("Checkout")]
      internal class CheckoutWidget : ViewComponent {}
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
      [ViewComponent("AccountMenu")]
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

  it('ignores commented-out C# helper calls', () => {
    expect(
      extractCsharpViewComponentInvocations(`
        // return ViewComponent("Hidden");
        return ViewComponent("Visible");
      `),
    ).toEqual(['Visible']);
  });
});
