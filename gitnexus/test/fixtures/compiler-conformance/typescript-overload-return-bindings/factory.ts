class Alpha { save() {} }
class Beta { save() {} }

export function make(value: number): Alpha;
export function make(value: string): Beta;
export function make(value: number | string): Alpha | Beta {
  return typeof value === 'number' ? new Alpha() : new Beta();
}

export class Factory {
  make(value: number): Alpha;
  make(value: string): Beta;
  make(value: number | string): Alpha | Beta {
    return typeof value === 'number' ? new Alpha() : new Beta();
  }
}
