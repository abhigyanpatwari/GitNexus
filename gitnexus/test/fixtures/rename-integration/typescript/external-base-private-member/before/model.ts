import { External } from "vendor";

export class Worker extends External {
    private target(): number { return 1; }
    invoke(): number { return this.target(); }
}
