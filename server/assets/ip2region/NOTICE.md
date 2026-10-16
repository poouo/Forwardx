# ip2region source-location data

Upstream: https://github.com/lionsoul2014/ip2region
Pinned commit: `1bf6cabfb63c1a14af0971749c2120a3e5c77d72`
Files: `data/ip2region_v4.xdb`, `data/ip2region_v6.xdb` (losslessly gzip-compressed).
License: Apache-2.0 OR MIT; distributed under MIT (LICENSE.txt).

Original SHA-256 and byte lengths:

- IPv4: `27ecba8c9a6d5e3b280aedbe7ee15c65372b179fbd0dad3845d8c608f2fcace1`, 11122642 bytes.
- IPv6: `939f6b46bd2b8bec3cf7c5ceb8ba782266ae9b1f35b5ba7916700dec0b7506ed`, 37277813 bytes.

Data is approximate network allocation information, not a user's precise location.
Only source-IP analytics uses these files. No runtime downloads or remote lookups
are required. Refresh by replacing the pinned assets and updating the hashes and
version in `server/operationsSourceGeo.ts`.
