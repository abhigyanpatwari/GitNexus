import { Injectable } from '@nestjs/common';

export interface Venue {
  id: string;
  name: string;
}

/**
 * Not a controller. It exists so each handler body calls a real symbol, and so
 * the `@Controller` file gate is shown skipping a decorated class that declares
 * no routes.
 */
@Injectable()
export class VenuesService {
  private readonly rows: Venue[] = [];

  listVenues(): Venue[] {
    return this.rows;
  }

  searchVenues(term: string): Venue[] {
    return this.rows.filter((row) => row.name.includes(term));
  }

  insertVenue(input: Venue): Venue {
    this.rows.push(input);
    return input;
  }

  deleteVenue(id: string): void {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index !== -1) this.rows.splice(index, 1);
  }
}
