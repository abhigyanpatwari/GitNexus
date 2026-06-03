import { describe, it, expect } from 'vitest';
import {
  encodeMarker,
  decodeMarker,
  isHeritageMarker,
  HERITAGE_MARKER_PREFIX,
  PROPERTY_MARKER_PREFIX,
} from '../../../src/core/ingestion/utils/heritage-marker.js';

describe('heritage-marker codec (#1994)', () => {
  it('encodes the exact Ruby/Dart wire format (byte-identical to the hand-rolled markers)', () => {
    expect(encodeMarker('heritage', ['include', 'Loggable', 'App.S'])).toBe(
      '__heritage__:include:Loggable:App.S',
    );
    expect(encodeMarker('property', ['attr_accessor', 'radius', 'Shapes.Circle'])).toBe(
      '__property__:attr_accessor:radius:Shapes.Circle',
    );
    expect(HERITAGE_MARKER_PREFIX).toBe('__heritage__:');
    expect(PROPERTY_MARKER_PREFIX).toBe('__property__:');
  });

  it('round-trips encode → decode for both kinds', () => {
    const heritage = encodeMarker('heritage', ['with', 'Logger', 'Service']);
    expect(decodeMarker(heritage)).toEqual({
      kind: 'heritage',
      fields: ['with', 'Logger', 'Service'],
    });
    const property = encodeMarker('property', ['attr_reader', 'name', 'User']);
    expect(decodeMarker(property)).toEqual({
      kind: 'property',
      fields: ['attr_reader', 'name', 'User'],
    });
  });

  it('throws on a colon-bearing field (the wire format reserves ":" as the delimiter)', () => {
    expect(() => encodeMarker('heritage', ['include', 'Outer::Mixin', 'User'])).toThrow(/':'/);
  });

  it('decodeMarker returns null for non-markers', () => {
    expect(decodeMarker('./relative/path')).toBeNull();
    expect(decodeMarker('package:foo/bar.dart')).toBeNull();
    expect(decodeMarker('')).toBeNull();
  });

  it('isHeritageMarker matches exactly the prior startsWith pair', () => {
    expect(isHeritageMarker('__heritage__:include:M:C')).toBe(true);
    expect(isHeritageMarker('__property__:attr:p:C')).toBe(true);
    expect(isHeritageMarker('Serializable')).toBe(false);
    expect(isHeritageMarker('dart:core')).toBe(false);
  });
});
