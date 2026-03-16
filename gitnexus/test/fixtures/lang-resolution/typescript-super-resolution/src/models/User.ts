import { BaseModel } from './Base';

export class User extends BaseModel {
  save(): boolean {
    super.save();
    return true;
  }
}
