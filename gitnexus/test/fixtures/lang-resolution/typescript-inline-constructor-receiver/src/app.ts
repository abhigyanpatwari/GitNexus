import { Box, Service, makeOther } from './svc';

export function viaInlineNew(db: number): number {
  return new Service(db).doWork();
}

export function viaFactory(db: number): number {
  return makeOther(db).doWork();
}

export function viaTwoStep(db: number): number {
  const s = new Service(db);
  return s.doWork();
}

export function viaGenericCtor(): number {
  return new Box<string>().unwrap();
}
