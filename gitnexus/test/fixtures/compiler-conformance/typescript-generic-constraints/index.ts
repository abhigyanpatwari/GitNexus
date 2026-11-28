export interface Shape { area: number; }
export type Box<T extends Shape> = T;
export function get<T extends Box<Shape>>(value: T) { return value; }
export type Alias = Shape;
export type Special = Box<Shape>;
