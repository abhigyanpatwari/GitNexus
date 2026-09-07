import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { VenuesService } from './venues.service';
import type { Venue } from './venues.service';

/**
 * The shape #3009 is about: the URL is split across two decorators. The class
 * decorator carries the prefix and the method decorator carries the verb plus
 * the remainder, so neither half is a route on its own.
 */
@Controller('venues')
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  // Pathless index route: its URL is the controller prefix and nothing else.
  @Get()
  findAll(): Venue[] {
    return this.venues.listVenues();
  }

  @Get('search')
  search(@Query('q') term: string): Venue[] {
    return this.venues.searchVenues(term);
  }

  // Same URL as findAll(), different verb — two Route nodes, not one.
  @Post()
  create(@Body() input: Venue): Venue {
    return this.venues.insertVenue(input);
  }

  @Delete(':id')
  remove(@Param('id') id: string): void {
    this.venues.deleteVenue(id);
  }
}
