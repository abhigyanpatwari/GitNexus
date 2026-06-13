import { describe, expect, it } from 'vitest';
import { isRfc1918PrivateIpv4 } from '../../src/server/private-ip.js';

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
