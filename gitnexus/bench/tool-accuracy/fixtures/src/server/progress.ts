export function mountProgress(app: any, routePath: string): void {
  app.get(routePath, (req: any, res: any) => res.json({ progress: 100 }));
}
