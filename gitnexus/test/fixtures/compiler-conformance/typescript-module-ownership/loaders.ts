import * as mod from './left.js';
      export async function useLocal() {
        const mod = await import('./right.js');
        const entity = new mod.Entity();
        entity.save();
      }
      export function useOuter() {
        const entity = new mod.Entity();
        entity.save();
      }