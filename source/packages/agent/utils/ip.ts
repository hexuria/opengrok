import { isIP } from "node:net";

function isLoopbackIpv4(ip: string): boolean {
  return ip.startsWith("127.");
}

function isPrivateIpv4(ip: string): boolean {
  if (ip === "0.0.0.0") return true;
  if (isLoopbackIpv4(ip)) return true;
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map(part => Number(part));
  if (nums.some(number => !Number.isInteger(number) || number < 0 || number > 255)) return false;
  const first = nums[0]!;
  const second = nums[1]!;
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 169 && second === 254) return true;
  return false;
}

function extractIpv4FromMappedIpv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dottedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dottedMatch) return dottedMatch[1]!;
  const hexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch) {
    const high = parseInt(hexMatch[1]!, 16);
    const low = parseInt(hexMatch[2]!, 16);
    return `${high >> 8 & 255}.${high & 255}.${low >> 8 & 255}.${low & 255}`;
  }
  return null;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;
  const mapped = extractIpv4FromMappedIpv6(lower);
  if (mapped) return isPrivateIpv4(mapped);
  return false;
}

export function isLoopbackIpHost(host: string): boolean {
  const hostname = host.toLowerCase();
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isLoopbackIpv4(hostname);
  if (ipVersion === 6) {
    if (hostname === "::1") return true;
    const mapped = extractIpv4FromMappedIpv6(hostname);
    return mapped !== null ? isLoopbackIpv4(mapped) : false;
  }
  return false;
}

export function isPrivateIpHost(host: string): boolean {
  const hostname = host.toLowerCase();
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4(hostname);
  if (ipVersion === 6) return isPrivateIpv6(hostname);
  return false;
}
