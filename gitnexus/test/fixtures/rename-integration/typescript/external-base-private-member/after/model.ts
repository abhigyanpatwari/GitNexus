import { External } from "vendor";

export class Worker extends External {
    private renamed(): number { return 1; }
    invoke(): number { return this.renamed(); }
}
