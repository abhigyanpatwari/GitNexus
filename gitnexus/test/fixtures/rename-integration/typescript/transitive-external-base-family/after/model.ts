import { External } from "vendor";

interface Contract extends External {}
export class Worker implements Contract {
    target(): number { return 1; }
}
