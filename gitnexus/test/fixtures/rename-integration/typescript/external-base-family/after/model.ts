import { External } from "vendor";

export class Worker implements External {
    target(): number { return 1; }
}
