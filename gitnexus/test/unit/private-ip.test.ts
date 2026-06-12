import { describe, expect, it } from 'vitest';
import { isValidIpv4Address, isRfc1918PrivateIpv4 } from '../../src/server/private-ip.js';

describe('isValidIpv4Address', () => {
  it('accepts valid IPv4 addresses', () => {
    expect(isValidIpv4Address('0.0.0.0')).toBe(true);
    expect(isValidIpv4Address('127.0.0.1')).toBe(true);
    expect(isValidIpv4Address('192.168.1.1')).toBe(true);
    expect(isValidIpv4Address('255.255.255.255')).toBe(true);
    expect(isValidIpv4Address('10.0.0.1')).toBe(true);
  });

  it('rejects invalid octets (>255)', () => {
    expect(isValidIpv4Address('256.0.0.1')).toBe(false);
    expect(isValidIpv4Address('10.0.0.256')).toBe(false);
    expect(isValidIpv4Address('999.999.999.999')).toBe(false);
  });

  it('rejects non-IPv4 strings', () => {
    expect(isValidIpv4Address('localhost')).toBe(false);
    expect(isValidIpv4Address('[::1]')).toBe(false);
    expect(isValidIpv4Address('::1')).toBe(false);
    expect(isValidIpv4Address('')).toBe(false);
    expect(isValidIpv4Address('10.0.0')).toBe(false);
    expect(isValidIpv4Address('10.0.0.1.2')).toBe(false);
    expect(isValidIpv4Address('abc.def.ghi.jkl')).toBe(false);
  });
});

describe('isRfc1918PrivateIpv4', () => {
  it('accepts 10.0.0.0/8 range', () => {
    expect(isRfc1918PrivateIpv4('10.0.0.0')).toBe(true);
    expect(isRfc1918PrivateIpv4('10.255.255.255')).toBe(true);
    expect(isRfc1918PrivateIpv4('10.1.2.3')).toBe(true);
  });

  it('accepts 172.16.0.0/12 range', () => {
    expect(isRfc1918PrivateIpv4('172.16.0.0')).toBe(true);
    expect(isRfc1918PrivateIpv4('172.31.255.255')).toBe(true);
    expect(isRfc1918PrivateIpv4('172.20.1.1')).toBe(true);
  });

  it('rejects 172.x outside /12 range', () => {
    expect(isRfc1918PrivateIpv4('172.15.255.255')).toBe(false);
    expect(isRfc1918PrivateIpv4('172.32.0.0')).toBe(false);
  });

  it('accepts 192.168.0.0/16 range', () => {
    expect(isRfc1918PrivateIpv4('192.168.0.0')).toBe(true);
    expect(isRfc1918PrivateIpv4('192.168.255.255')).toBe(true);
    expect(isRfc1918PrivateIpv4('192.168.1.100')).toBe(true);
  });

  it('rejects 192.x outside /16 range', () => {
    expect(isRfc1918PrivateIpv4('192.167.1.1')).toBe(false);
    expect(isRfc1918PrivateIpv4('192.169.1.1')).toBe(false);
  });

  it('rejects public IPs', () => {
    expect(isRfc1918PrivateIpv4('8.8.8.8')).toBe(false);
    expect(isRfc1918PrivateIpv4('1.1.1.1')).toBe(false);
    expect(isRfc1918PrivateIpv4('203.0.113.1')).toBe(false);
  });

  it('rejects non-IPv4 input', () => {
    expect(isRfc1918PrivateIpv4('localhost')).toBe(false);
    expect(isRfc1918PrivateIpv4('[::1]')).toBe(false);
    expect(isRfc1918PrivateIpv4('')).toBe(false);
  });
});
