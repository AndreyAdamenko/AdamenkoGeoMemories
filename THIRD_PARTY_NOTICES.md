# Third-party software

AdamenkoGeoMemories source code and original branding are licensed under **GPL-3.0-only**. Dependencies retain their respective licenses; the project license does not replace them.

| Component         | License                                            | Source                                                 |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------ |
| React / React DOM | MIT                                                | https://github.com/facebook/react                      |
| Express           | MIT                                                | https://github.com/expressjs/express                   |
| Leaflet           | BSD-2-Clause                                       | https://github.com/Leaflet/Leaflet                     |
| Supercluster      | ISC                                                | https://github.com/mapbox/supercluster                 |
| Sharp             | Apache-2.0                                         | https://github.com/lovell/sharp                        |
| exiftool-vendored | MIT                                                | https://github.com/photostructure/exiftool-vendored.js |
| ExifTool          | Perl licensing terms (Artistic License or GNU GPL) | https://exiftool.org/                                  |
| Node.js           | MIT and bundled third-party notices                | https://github.com/nodejs/node/blob/main/LICENSE       |
| Vite              | MIT                                                | https://github.com/vitejs/vite                         |
| TypeScript        | Apache-2.0                                         | https://github.com/microsoft/TypeScript                |

Sharp uses libvips (LGPL-2.1-or-later) and other native libraries. Refer to the license and notice files shipped with the installed packages for the exact bundled components. Preserve these files when distributing a portable bundle, including Node.js, ExifTool and native image-processing dependencies. `package-lock.json` records the dependency versions.

The application displays OpenStreetMap attribution on the map. Map data is provided by [OpenStreetMap contributors](https://www.openstreetmap.org/copyright); use of the public tile service is governed by the [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
