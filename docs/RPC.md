# RPC Server Notes

QubitCoin's RPC server uses the client IP address for per-IP rate limiting on every `/api/v1/*` route.

## Proxy trust

The daemon accepts a `--rpc-trust-proxy` option that controls when `X-Forwarded-For` is trusted.

- Default: `loopback,linklocal,uniquelocal`
- Disable forwarded headers entirely: `--rpc-trust-proxy=false`
- Trust every proxy hop: `--rpc-trust-proxy=true`
- Trust one proxy hop: `--rpc-trust-proxy=1`
- Trust only loopback proxies: `--rpc-trust-proxy=loopback`
- Trust two proxy hops: `--rpc-trust-proxy=2`
- Trust explicit networks: `--rpc-trust-proxy=10.0.0.0/8,192.168.0.0/16`

Boolean mode is explicit: use `true`/`on` to trust every proxy hop, and `false`/`off`/`0` to ignore forwarded headers entirely.

Hop counts must be positive integers, so `1` means one trusted proxy hop, `2` means two trusted hops, and so on. Numeric-like values that are not valid positive integers, such as `-1` or `1.5`, are rejected at startup instead of being treated as proxy labels.

The default is intended for common reverse-proxy and ingress setups where qbtcd receives traffic from a local or private upstream hop. In that case, rate limiting still keys off the real client IP instead of collapsing every caller into the proxy address.

If the RPC port is exposed directly to clients without a trusted proxy in front of it, set `--rpc-trust-proxy=false` so untrusted peers cannot influence client-IP detection with forwarded headers.

## Deployment guidance

- Directly exposed RPC listener: keep `--rpc-trust-proxy=false`.
- Same-host nginx/Caddy/HAProxy in front of qbtcd: keep the default, or narrow it to `loopback`.
- Container/Kubernetes/private-network ingress: set `--rpc-trust-proxy` to the specific private ranges or proxy hops that can reach qbtcd.

Do not infer proxy trust from `--rpc-bind`. Binding to `127.0.0.1` or `0.0.0.0` only controls where the socket listens; it does not identify whether the immediate upstream peer is a trusted proxy.
