import { describe, expect, it } from 'vitest';
import { extractXamlDeclarations } from '../../src/core/ingestion/documents/xaml.js';

const NS = 'http://schemas.microsoft.com/winfx/2006/xaml';

describe('XAML document declarations (#3202)', () => {
  it.each(['\n', '\r\n', '\r'])('preserves source lines with %j line endings', (newline) => {
    const source = [
      `<Page xmlns:x="${NS}" x:Class="App.Home">`,
      '  <!-- <Button x:Name="Fake" /> -->',
      '  <Grid>',
      '    <Button x:Name="SaveButton" Content="Save" />',
      '    <Style x:Key="PrimaryButton">',
      '      <Setter Property="Width" Value="20" />',
      '    </Style>',
      '  </Grid>',
      '</Page>',
    ].join(newline);
    expect(extractXamlDeclarations(source)).toEqual([
      {
        name: 'App.Home',
        description: 'Page x:Class declaration',
        startIndex: 0,
        startLine: 0,
        endLine: 8,
        level: 1,
      },
      {
        name: 'SaveButton',
        description: 'Button x:Name declaration',
        startIndex: source.replace(/\r\n?/g, '\n').indexOf('<Button x:Name="SaveButton"'),
        startLine: 3,
        endLine: 3,
        level: 3,
      },
      {
        name: 'PrimaryButton',
        description: 'Style x:Key declaration',
        startIndex: source.replace(/\r\n?/g, '\n').indexOf('<Style'),
        startLine: 4,
        endLine: 6,
        level: 3,
      },
    ]);
  });

  it('uses namespace identity, including alternate prefixes and scoped rebinding', () => {
    const declarations = extractXamlDeclarations(`<Grid xmlns:d="${NS}" xmlns:x="urn:not-xaml">
      <Button d:Name="Real" x:Name="WrongNamespace" Name="Unqualified" />
      <Panel xmlns:d="urn:other"><Button d:Name="Shadowed" /></Panel>
      <Panel xmlns:q="${NS}"><Button q:Name="Nested" /></Panel>
      <Button d:Name="AfterScope" />
    </Grid>`);
    expect(declarations.map((d) => d.name)).toEqual(['Real', 'Nested', 'AfterScope']);
  });

  it('does not infer bindings, handlers, dynamic resource keys or undeclared x prefixes', () => {
    expect(
      extractXamlDeclarations(`<Grid xmlns:x="${NS}">
      <Button Content="{Binding User}" Click="Save" />
      <Style x:Key="{x:Type Button}" /><Style x:Key="{}escaped" />
      <Button x:Name="" /><Style x:Key="A&amp;B" />
      <![CDATA[<Button x:Name="Fake" />]]>
    </Grid>`),
    ).toEqual([]);
    expect(extractXamlDeclarations('<Button x:Name="Undeclared" />')).toEqual([]);
  });

  it('keeps duplicate names distinct and preserves Unicode names', () => {
    const declarations = extractXamlDeclarations(
      `<Grid xmlns:x="${NS}"><Button x:Name="Save" /><Button x:Name="Save" /><Button x:Name="\u03a9" /></Grid>`,
    );
    expect(declarations.map((d) => d.name)).toEqual(['Save', 'Save', '\u03a9']);
    expect(new Set(declarations.map((d) => d.startIndex)).size).toBe(3);
  });

  it.each([
    '<Grid><Button></Grid>',
    `<!DOCTYPE Grid [<!ENTITY label SYSTEM "file:///private">]><Grid xmlns:x="${NS}" x:Name="&label;" />`,
    `${'<Grid>'.repeat(101)}${'</Grid>'.repeat(101)}`,
  ])('rejects malformed or unsupported input without partial declarations', (source) => {
    expect(() => extractXamlDeclarations(source)).toThrow();
  });
});
