export class BaseModel {
  save(): boolean { return true; }
}

export interface Serializable {
  serialize(): string;
}
