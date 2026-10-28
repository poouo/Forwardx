# Third-Party Notices

## ForwardX runtime / GOST

- Upstream: <https://github.com/go-gost/gost>, version 3.2.6.
- Pinned source commit: `340ba32ef0bebc7293908007cc423dd5f33dd88c`.
- License: MIT. Copyright (c) 2016 ginuerzh.
- Usage: built from pinned upstream source as `forwardx-runtime` for Linux amd64/arm64.
- Modifications: CLI product label and version/build identity only. Upstream protocol and configuration behavior is retained. Dependency versions and checksums remain those of the pinned source.
- Build recipe: `scripts/build-runtime.sh`; source archive SHA-256 is pinned in `shared/runtimeBuild.ts`. Bundles include `dist/agent/RUNTIME_LICENSE.txt` and `dist/agent/RUNTIME_BUILD.txt` for full upstream license and source/build/checksum provenance.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## resvg-js (build tool only)

- Package: `@resvg/resvg-js` 2.6.2, MPL-2.0.
- Upstream/source: <https://github.com/yisibl/resvg-js>.
- Usage: rendering project-owned SVG logo geometry to bundled native app icon PNGs during development/build. The renderer is not included in browser or mobile runtime code.
- Full license is retained in `node_modules/@resvg/resvg-js/LICENSE`; no upstream source modifications.

## ExcelJS

- Upstream: <https://github.com/exceljs/exceljs>
- Version: 4.4.0, MIT license.
- Usage: server-side styled Excel billing exports.
- Copyright (c) 2014-2019 Guyon Roche.
- Full license is retained in `node_modules/exceljs/LICENSE` in runtime distributions.

## ip2region

- Upstream: <https://github.com/lionsoul2014/ip2region>
- JavaScript binding: `ip2region.js` 3.1.8 (Apache-2.0 OR MIT).
- Bundled IPv4/IPv6 XDB data: commit `1bf6cabfb63c1a14af0971749c2120a3e5c77d72`, distributed under MIT.
- Usage: offline operations source-IP analytics only.
- Copyright (c) 2015 Lionsoul<chenxin619315@gmail.com>.
- Full MIT license and data checksums: `dist/geo/LICENSE.txt` and `dist/geo/NOTICE.md` in runtime bundles, `server/assets/ip2region/` in source checkouts.

## scaffold-master / Pearl Glass UI

- Upstream: <https://github.com/wbr664393425-lgtm/scaffold-master>
- License: MIT
- Usage: adapted design tokens, surface styling, instrument-style presentation,
  and navigation/motion concepts in the React panel. The upstream Vue runtime
  and GSAP implementation are not included.

Copyright (c) 2026 wbr664393425-lgtm

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

ForwardX Agent includes the userspace WireGuard implementation from the
official `wireguard-go` project.

## WireGuard userspace implementation

- Go module: `golang.zx2c4.com/wireguard`
- Pinned revision: `v0.0.0-20250521234502-f333402bd9cb`
- Upstream source: <https://git.zx2c4.com/wireguard-go/>
- License: MIT
- Usage: compiled into the ForwardX Agent binary

Copyright (C) 2017-2025 WireGuard LLC. All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
