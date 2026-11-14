# Third-party notices

The platform itself is under the BSD 3-Clause license ([LICENSE](LICENSE)). This file lists third-party code that the
platform's own build outputs include, with its license. It covers the script engine of interactive messages
([docs/HYPERTEXT.md](docs/HYPERTEXT.md)). Other dependencies are not listed here yet; each keeps its license file in
its package (see the lockfiles).

## The interactive-message script engine

| component | version | license | copyright |
|---|---|---|---|
| QuickJS, the JavaScript engine, compiled to WebAssembly | 2025-09-13+f1139494, as vendored in quickjs-emscripten 0.32.0 | MIT | Copyright (c) 2017-2021 Fabrice Bellard; Copyright (c) 2017-2021 Charlie Gordon |
| `quickjs-emscripten-core` | 0.32.0 | MIT | quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis |
| `@jitl/quickjs-wasmfile-release-sync`, the QuickJS WASM build and its loader | 0.32.0 | MIT | quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis; QuickJS as above |
| `@jitl/quickjs-ffi-types`, a dependency of both packages | 0.32.0 | MIT | quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis |

Where they ship:

- **Web:** the build (`frontend/dist`) holds them in the worker asset `assets/hypertext-worker-<hash>.js`, its loader
  chunk `assets/emscripten-module.browser-<hash>.js` and the WASM `assets/emscripten-module-<hash>.wasm`. A browser
  loads them only when a viewer first uses a control that runs a card's script. The worker asset carries the MIT
  notices of quickjs-emscripten and QuickJS, from the `/*!` comment in `frontend/src/hypertext/hypertext-worker.ts`,
  which the build keeps.
- **Desktop:** the Tauri app bundles the same `frontend/dist`.
- **Android and iOS:** the mobile bundle `mobile/contracts/hypertext/hypertext-engine.js`, with the WASM inlined, is an
  app asset (Android: `mobile/android/app/build.gradle.kts`; iOS: the `hypertext/` folder resource of
  `mobile/ios/project.yml`). Its build, `mobile/scripts/build-hypertext.mjs`, keeps legal comments
  (`legalComments: 'eof'`), so the MIT notices of quickjs-emscripten and QuickJS, taken from the `/*!` comment in
  `mobile/hypertext/engine.ts`, stay at the end of the bundle (its last comment, before the wrapper's closing `})();`).

The exact pins are in `frontend/package.json`, and the WASM's SHA-256 is in
`mobile/contracts/fixtures/hypertext-client.json`. Update this file when the engine is upgraded
([docs/HYPERTEXT.md](docs/HYPERTEXT.md#upgrading-the-script-engine-apps)).

## License texts

The texts below are copied from the packages' `LICENSE` files.

### quickjs-emscripten-core and @jitl/quickjs-ffi-types

From `quickjs-emscripten-core/LICENSE`; `@jitl/quickjs-ffi-types/LICENSE` is the same file.

```text
The MIT License

quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis

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
```

### @jitl/quickjs-wasmfile-release-sync (quickjs-emscripten and QuickJS)

From `@jitl/quickjs-wasmfile-release-sync/LICENSE`.

```text
quickjs-emscripten:
The MIT License

quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis

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


quickjs:
QuickJS Javascript Engine

Copyright (c) 2017-2021 Fabrice Bellard
Copyright (c) 2017-2021 Charlie Gordon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
