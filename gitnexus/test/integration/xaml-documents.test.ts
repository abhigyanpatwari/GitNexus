import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { generateId } from '../../src/lib/utils.js';

const NS = 'http://schemas.microsoft.com/winfx/2006/xaml';
const fixtures: Awaited<ReturnType<typeof createTempDir>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

describe('XAML pipeline documents (#3202)', () => {
  it('indexes literal names and resource keys, with no invented runtime edges', async () => {
    const repo = await createTempDir();
    fixtures.push(repo);
    await fs.writeFile(
      path.join(repo.dbPath, 'Home.XAML'),
      `<Page xmlns:x="${NS}" x:Class="App.Home">\n<Button x:Name="Save" Click="SaveClicked" />\n<Style x:Key="Accent" />\n</Page>`,
    );
    await fs.writeFile(
      path.join(repo.dbPath, 'Broken.xaml'),
      `<Grid xmlns:x="${NS}" x:Name="Bad"><Button></Grid>`,
    );
    const result = await runPipelineFromRepo(repo.dbPath, () => {}, { skipGraphPhases: true });
    const nodes = [...result.graph.iterNodes()];
    expect(
      nodes
        .filter((node) => node.label === 'File')
        .map((node) => node.properties.name)
        .sort(),
    ).toEqual(['Broken.xaml', 'Home.XAML']);
    const declarations = nodes.filter((node) => node.label === 'Section');
    expect(declarations.map((node) => node.properties.name).sort()).toEqual([
      'Accent',
      'App.Home',
      'Save',
    ]);
    expect(declarations.find((node) => node.properties.name === 'Save')?.properties.startLine).toBe(
      1,
    );
    expect(
      [...result.graph.iterRelationships()].filter((edge) => edge.type !== 'CONTAINS'),
    ).toEqual([]);
    const fileId = generateId('File', 'Home.XAML');
    expect(
      [...result.graph.iterRelationshipsByType('CONTAINS')]
        .filter((edge) => edge.sourceId === fileId)
        .map((edge) => edge.targetId)
        .sort(),
    ).toEqual(declarations.map((node) => node.id).sort());

    await fs.writeFile(
      path.join(repo.dbPath, 'Home.XAML'),
      `<Grid xmlns:x="${NS}"><Button x:Name="Renamed" /></Grid>`,
    );
    const changed = await runPipelineFromRepo(repo.dbPath, () => {}, { skipGraphPhases: true });
    expect(
      [...changed.graph.iterNodes()]
        .filter((node) => node.label === 'Section')
        .map((node) => node.properties.name),
    ).toEqual(['Renamed']);
    await fs.unlink(path.join(repo.dbPath, 'Home.XAML'));
    const deleted = await runPipelineFromRepo(repo.dbPath, () => {}, { skipGraphPhases: true });
    expect([...deleted.graph.iterNodes()].filter((node) => node.label === 'Section')).toEqual([]);
  }, 60_000);
});
