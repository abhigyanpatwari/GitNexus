import type express from 'express';

export const mountSSEProgress = (app: express.Express, routePath: string, jm: unknown) => {
  app.get(routePath, (_req, res) => {
    res.write(`data: ${JSON.stringify(jm)}\n\n`);
  });
};
