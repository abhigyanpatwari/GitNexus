import { BaseModel } from './Base';

export class User extends BaseModel<string> {
  save(): boolean {
    super.save();
    return true;
  }
}
