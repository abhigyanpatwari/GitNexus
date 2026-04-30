export async function loadFeature(): Promise<void> {
  const mod = await import('./feature');
  const feature = new mod.Feature();
  feature.activate();
}
