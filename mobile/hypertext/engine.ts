// The card engine for Android and iOS: bundled by mobile/scripts/build-hypertext.mjs into
// mobile/contracts/hypertext/hypertext-engine.js and run in a hidden, network-blocked WebView (HypertextEngine.kt,
// HypertextEngine.swift) that has no bridge. Native code polls MobileHypertext.ready, calls
// MobileHypertext.run(json) and reads the JSON it resolves to. The same engine.ts, prelude and effects.ts as the web,
// and the same WASM bytes (inlined, never fetched). Native code checks the result again before it calls REST.
//
// Request: {doc, state, handler, event, viewer, prev?} (doc as stored in messages.hypertext; state after the binding
// change; prev the state before it). Result: effects.ts RunResult.
/*! quickjs-emscripten: The MIT License. quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis.
 *  QuickJS Javascript Engine: The MIT License. Copyright (c) 2017-2021 Fabrice Bellard, Copyright (c) 2017-2021 Charlie Gordon.
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 *  documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 *  rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 *  persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice
 *  and this permission notice shall be included in all copies or substantial portions of the Software.
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 *  WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 *  COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *  OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. */
import wasm from '@jitl/quickjs-wasmfile-release-sync/wasm';
import { ENGINE_VERSION, runAction } from '../../frontend/src/hypertext/engine';
import { failure, validateOutput } from '../../frontend/src/hypertext/effects';
import { parseDoc } from '../../frontend/src/hypertext/format';
import { validateState } from '../../frontend/src/hypertext/bindings';
import { isId, isObject } from '../../frontend/src/hypertext/text';
import type { HxEvent, State, Viewer } from '../../frontend/src/hypertext/types';

const api = { ready: false, version: ENGINE_VERSION, run };
const compiled: Promise<WebAssembly.Module | null> = typeof WebAssembly === 'undefined' ? Promise.resolve(null)
  : WebAssembly.compile(wasm as unknown as Uint8Array).catch(() => null);
void compiled.then(() => { api.ready = true; });

async function run(json: string): Promise<string> {
  try {
    const req = JSON.parse(json);
    const doc = parseDoc(req?.doc);
    if (!doc) return JSON.stringify(failure('engine', 'this message cannot be run by this app version'));
    const state = req.state as State, prev = (req.prev ?? req.state) as State;
    const st = validateState(doc, state);
    if (!st.ok) return JSON.stringify(failure('invalid_state', st.error));
    if (!validateState(doc, prev).ok) return JSON.stringify(failure('invalid_state', 'the previous state is not valid'));
    const ev = req.event, vw = req.viewer;
    if (!isId(req.handler) || !isObject(ev) || !['change', 'submit', 'click'].includes(ev.type as string) || !isId(ev.node) || !isObject(vw)) {
      return JSON.stringify(failure('engine', 'malformed request'));
    }
    const module = await compiled;
    if (!module) return JSON.stringify(failure('engine_unavailable', 'WebAssembly is not available on this device'));
    const event: HxEvent = { type: ev.type as HxEvent['type'], node: ev.node as string, value: (ev.value ?? null) as HxEvent['value'] };
    const viewer: Viewer = { gm: vw.gm === true, actor: vw.actor === true, character: typeof vw.character === 'string' ? vw.character : null };
    const out = await runAction(module, { doc, state, handler: req.handler, event, viewer });
    return JSON.stringify(validateOutput(doc, prev, out));
  } catch (e) {
    return JSON.stringify(failure('engine', e instanceof Error ? e.message : String(e)));
  }
}

(globalThis as any).MobileHypertext = api;
