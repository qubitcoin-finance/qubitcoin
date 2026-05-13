export const DEFAULT_TRUSTED_PROXIES = ['loopback', 'linklocal', 'uniquelocal'] as const

export type RpcTrustProxy = boolean | number | string | string[]

export function parseRpcTrustProxy(value: string | undefined): RpcTrustProxy {
  if (value === undefined || value.trim() === '') {
    return [...DEFAULT_TRUSTED_PROXIES]
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'false' || normalized === '0' || normalized === 'off' || normalized === 'none') {
    return false
  }
  if (normalized === 'true' || normalized === 'on') {
    return true
  }
  if (/^[1-9]\d*$/.test(normalized)) {
    return parseInt(normalized, 10)
  }
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid --rpc-trust-proxy value "${value}": hop count must be a positive integer, 0/false, or a proxy list`)
  }

  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}
