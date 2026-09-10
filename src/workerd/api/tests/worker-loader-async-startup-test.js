// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
import assert from 'node:assert';
import { WorkerEntrypoint } from 'cloudflare:workers';
import addWasmBytes from './add.wasm.bin';

let outboundRequests = 0;
let sourceRequests = 0;
let moduleFallbackRequests = [];
let activeModuleFallbackRequests = 0;
let maxActiveModuleFallbackRequests = 0;

// Holds a module fallback response open long enough for concurrent fetches to
// overlap, and records how many were in flight at once.
async function respondWithTrackedConcurrency(respond) {
  ++activeModuleFallbackRequests;
  maxActiveModuleFallbackRequests = Math.max(
    maxActiveModuleFallbackRequests,
    activeModuleFallbackRequests
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return respond();
  } finally {
    --activeModuleFallbackRequests;
  }
}

export class Outbound extends WorkerEntrypoint {
  async fetch(request) {
    if (request.method === 'POST') {
      assert.strictEqual(
        request.headers.get('authorization'),
        'Kitesurf-Module-Fallback'
      );
      const resolution = await request.json();
      moduleFallbackRequests.push(resolution);
      switch (resolution.specifier) {
        case 'file:///bundle/main.js':
          return Response.json({
            esModule: `
              import { message } from './message.js';
              import value from './value.json' with { type: 'json' };

              export default {
                fetch() {
                  return new Response(message + ':' + value.answer + ':' + import.meta.main);
                },
              };
            `,
          });
        case 'file:///bundle/message.js':
          return Response.json({
            esModule: "export const message = 'fallback';",
          });
        case 'file:///bundle/remote.js':
          return Response.json({
            esModule: "export const remote = 'remote';",
          });
        case 'file:///bundle/fallback-only.js':
          return Response.json({
            esModule: `
              import value from './transitive.js';
              const dynamicValue = (await import('./dynamic-transitive.js')).default;
              let dynamicBuiltinRejected = false;
              try {
                await import('workerd:unsafe-eval');
              } catch {
                dynamicBuiltinRejected = true;
              }
              export default 'fallback:' + value + ':' + dynamicValue + ':' + dynamicBuiltinRejected;
            `,
          });
        case 'file:///bundle/transitive.js':
          return Response.json({
            esModule: "export default 'fallback-dependency';",
          });
        case 'file:///bundle/dynamic-transitive.js':
          return Response.json({
            esModule: "export default 'fallback-dynamic';",
          });
        case 'file:///bundle/static-builtin.js':
          return Response.json({
            esModule: `
              import unsafeEval from 'workerd:unsafe-eval';
              export default unsafeEval;
            `,
          });
        case 'file:///bundle/identity-normal-first.js':
        case 'file:///bundle/identity-fallback-first.js':
          return Response.json({
            esModule: `
              import dependency from './identity-dependency.js';
              export default { dependency };
            `,
          });
        case 'file:///bundle/identity-dependency.js':
          return Response.json({
            esModule: "export default 'fallback-identity';",
          });
        case 'file:///bundle/fallback-cjs.js':
          return Response.json({
            commonJsModule: "module.exports = 'commonjs';",
          });
        case 'file:///bundle/referrerless.js':
          return Response.json({
            esModule: `
              import value from './referrerless-dependency.js';
              const timer = await new Promise((resolve) => setTimeout(resolve, 0, 'timer'));
              export default 'referrerless:' + value + ':' + timer;
            `,
          });
        case 'file:///bundle/referrerless-dependency.js':
          return Response.json({ esModule: "export default 'dependency';" });
        case 'file:///bundle/referrer/fallback-relative.js':
          return Response.json({ esModule: "export default 'relative';" });
        case 'file:///bundle/value.json':
          return Response.json({ json: '{"answer":42}' });
        case 'file:///bundle/runtime-redirect.js':
          return new Response(null, {
            status: 301,
            headers: { location: 'file:///canonical/runtime.js' },
          });
        case 'file:///canonical/runtime.js':
          return Response.json({
            esModule: `
              import { dependency } from './runtime-dependency.js';
              export const value = 'runtime:' + dependency;
              export const moduleUrl = import.meta.url;
              export const resolvedNested = import.meta.resolve('./runtime-nested.js');
              export async function loadNested() {
                return (await import('./runtime-nested.js')).nested;
              }
            `,
          });
        case 'file:///canonical/runtime-dependency.js':
          return Response.json({
            esModule: "export const dependency = 'dependency';",
          });
        case 'file:///canonical/runtime-nested.js':
          return Response.json({
            esModule: "export const nested = 'nested';",
          });
        case 'file:///bundle/runtime-value.json':
          return Response.json({ json: '{"answer":42}' });
        case 'file:///bundle/runtime-query.js?version=1':
          return Response.json({
            esModule: `
              export default 'query';
              export async function loadNestedQuery() {
                return (await import('./runtime-query-child.js?version=2')).default;
              }
            `,
          });
        case 'file:///bundle/runtime-query-child.js?version=2':
          return Response.json({ esModule: "export default 'nested-query';" });
        case 'file:///bundle/query-identity.js?version=1':
          return Response.json({
            esModule:
              'export const version = 1; export const url = import.meta.url;',
          });
        case 'file:///bundle/query-identity.js?version=2':
          return Response.json({
            esModule:
              'export const version = 2; export const url = import.meta.url;',
          });
        case 'file:///bundle/queryless-redirect.js?version=1':
          return new Response(null, {
            status: 301,
            headers: { location: 'file:///bundle/queryless-redirect.js' },
          });
        case 'file:///bundle/queryless-redirect.js':
          return Response.json({
            esModule:
              "export default 'redirected'; export const url = import.meta.url;",
          });
        case 'file:///bundle/redirect-cycle-a.js?version=1':
          return new Response(null, {
            status: 301,
            headers: {
              location: 'file:///bundle/redirect-cycle-b.js?version=2',
            },
          });
        case 'file:///bundle/redirect-cycle-b.js?version=2':
          return new Response(null, {
            status: 301,
            headers: {
              location: 'file:///bundle/redirect-cycle-a.js?version=1',
            },
          });
        case 'file:///bundle/add.wasm':
        case 'file:///bundle/add-runtime.wasm':
          return new Response(addWasmBytes, {
            headers: { 'content-type': 'application/wasm' },
          });
        case 'file:///bundle/payload.bin':
        case 'file:///bundle/payload-runtime.bin':
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { 'content-type': 'application/octet-stream;foo=bar' },
          });
        case 'file:///bundle/concurrent-a.js':
        case 'file:///bundle/concurrent-b.js':
          return respondWithTrackedConcurrency(() =>
            Response.json({
              esModule: `export default '${resolution.specifier.at(-4)}';`,
            })
          );
        case 'file:///bundle/fanout.js':
          return Response.json({
            esModule: `
              import a from './fanout-a.js';
              import b from './fanout-b.js';
              import c from './fanout-c.js';
              export default [a, b, c].join(':');
            `,
          });
        // The conditional-polyfill pattern: a module's top-level await gates on a
        // dynamic import so that every importer waits for the polyfill. Two sibling
        // consumers import the gate (the shape that trips WebKit).
        case 'file:///bundle/polyfill-main.js':
          return Response.json({
            esModule: `
              import result from './polyfill-entry.js';
              export default {
                fetch() {
                  return new Response(result);
                },
              };
            `,
          });
        case 'file:///bundle/polyfill-entry.js':
          return Response.json({
            esModule: `
              import './polyfill-consumer-a.js';
              import './polyfill-consumer-b.js';
              import { polyfillLoaded } from './conditionally-load-polyfill.js';
              export default [
                polyfillLoaded,
                globalThis.popoverPolyfilled,
                globalThis.consumersSawPolyfill,
              ].join(':');
            `,
          });
        case 'file:///bundle/polyfill-consumer-a.js':
        case 'file:///bundle/polyfill-consumer-b.js':
          return Response.json({
            esModule: `
              import './conditionally-load-polyfill.js';
              // Runs only once the gate's top-level await has settled.
              globalThis.consumersSawPolyfill =
                (globalThis.consumersSawPolyfill ?? 0) +
                (globalThis.popoverPolyfilled ? 1 : 0);
            `,
          });
        case 'file:///bundle/conditionally-load-polyfill.js':
          return Response.json({
            esModule: `
              if (
                typeof HTMLElement === 'undefined' ||
                !('popover' in HTMLElement.prototype)
              ) {
                await import('./popover-polyfill.js');
              }
              export const polyfillLoaded = true;
            `,
          });
        case 'file:///bundle/popover-polyfill.js':
          return Response.json({
            esModule: 'globalThis.popoverPolyfilled = true;',
          });
        case 'file:///bundle/shared-a.js':
        case 'file:///bundle/shared-b.js':
          return respondWithTrackedConcurrency(() =>
            Response.json({
              esModule: `
                import dep from './shared-dep.js';
                export default '${resolution.specifier.at(-4)}:' + dep;
              `,
            })
          );
        case 'file:///bundle/shared-dep.js':
          return respondWithTrackedConcurrency(() =>
            Response.json({ esModule: "export default 'dep';" })
          );
        case 'file:///bundle/fanout-main.js':
          return Response.json({
            esModule: `
              import a from './fanout-a.js';
              import b from './fanout-b.js';
              import c from './fanout-c.js';
              export default {
                fetch() {
                  return new Response([a, b, c].join(':'));
                },
              };
            `,
          });
        case 'file:///bundle/fanout-a.js':
          return respondWithTrackedConcurrency(() =>
            Response.json({
              esModule: `
                import child from './fanout-a-child.js';
                export default 'a-' + child;
              `,
            })
          );
        case 'file:///bundle/fanout-b.js':
        case 'file:///bundle/fanout-c.js':
          return respondWithTrackedConcurrency(() =>
            Response.json({
              esModule: `export default '${resolution.specifier.at(-4)}';`,
            })
          );
        case 'file:///bundle/fanout-a-child.js':
          return respondWithTrackedConcurrency(() =>
            Response.json({ esModule: "export default 'child';" })
          );
        case 'file:///bundle/fanout-broken.js':
          return Response.json({
            esModule: `
              import a from './fanout-a.js';
              import missing from './fanout-missing.js';
              import c from './fanout-c.js';
              export default [a, missing, c].join(':');
            `,
          });
        default:
          return new Response('not found', { status: 404 });
      }
    }

    ++outboundRequests;
    return new Response('fetched');
  }
}

export class CapabilityFactory extends WorkerEntrypoint {
  get() {
    return this.ctx.exports.Outbound({});
  }
}

async function testAsyncStartup(env, ctx, name, extraFlags = []) {
  outboundRequests = 0;
  sourceRequests = 0;
  const testDynamicImportIo = extraFlags.includes('new_module_registry');
  const dynamicImportSource = testDynamicImportIo
    ? "(await import('./dynamic-io.js')).default"
    : "'not-tested'";
  const worker = env.loader.get(name, () => {
    ++sourceRequests;
    return {
      compatibilityDate: '2025-01-01',
      compatibilityFlags: [
        'allow_eval_during_startup',
        'allow_insecure_inefficient_logged_eval',
        'allow_importable_env',
        'dynamic_worker_async_startup',
        ...extraFlags,
      ],
      allowExperimental: true,
      mainModule: 'main.js',
      modules: {
        'main.js': `
          import { env } from 'cloudflare:workers';

          const timerResult = await new Promise((resolve) => {
            setTimeout(() => resolve('timer'), 1);
          });
          const fetchResult = await (await fetch('https://example.com/')).text();
          const returnedService = await env.capabilityFactory.get(null);
          const capabilityResult =
              await (await returnedService.fetch('https://example.com/')).text();
          const startupEvalResult = eval("'startup-eval'");
          const dynamicImportResult = ${dynamicImportSource};

          export default {
            fetch() {
              const runtimeEvalResult = eval("'runtime-eval'");
              const runtimeFunctionResult = new Function("return 'runtime-function'")();
              return new Response(
                  timerResult + ':' + fetchResult + ':' + capabilityResult + ':' +
                  startupEvalResult + ':' + runtimeEvalResult + ':' + runtimeFunctionResult +
                  ':' + dynamicImportResult);
            },
          };
        `,
        'dynamic-io.js': `
          const fetchResult = await (await fetch('data:text/plain,fetched')).text();
          const timerResult = await new Promise((resolve) => {
            setTimeout(() => resolve('timer'), 1);
          });
          const randomLength = crypto.randomUUID().length;
          export default fetchResult + ':' + timerResult + ':' + randomLength;
        `,
      },
      env: {
        capabilityFactory: ctx.exports.CapabilityFactory({}),
      },
      globalOutbound: ctx.exports.Outbound({}),
    };
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(sourceRequests, 1);
  assert.strictEqual(outboundRequests, 0);

  const responses = await Promise.all([
    worker.getEntrypoint().fetch('https://example.com/'),
    worker.getEntrypoint().fetch('https://example.com/'),
  ]);
  for (const response of responses) {
    assert.strictEqual(
      await response.text(),
      'timer:fetched:fetched:startup-eval:runtime-eval:runtime-function' +
        (testDynamicImportIo ? ':fetched:timer:36' : ':not-tested')
    );
  }
  assert.strictEqual(outboundRequests, 2);
}

export const asyncStartup = {
  async test(ctrl, env, ctx) {
    await testAsyncStartup(env, ctx, 'asyncStartup');
  },
};

export const asyncStartupNewModuleRegistry = {
  async test(ctrl, env, ctx) {
    await testAsyncStartup(env, ctx, 'asyncStartupNewModuleRegistry', [
      'new_module_registry',
    ]);
  },
};

// With dynamic_worker_async_startup, a module loaded with import() at request time
// evaluates inside the request's IoContext, so its top-level code can do I/O.
export const concurrentRuntimeDynamicImportIo = {
  async test(ctrl, env) {
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      compatibilityFlags: [
        'new_module_registry',
        'dynamic_worker_async_startup',
      ],
      allowExperimental: true,
      mainModule: 'main.js',
      modules: {
        'main.js': `
          let requestCount = 0;
          let releaseEvaluation;
          export const evaluationBarrier = new Promise((resolve) => {
            releaseEvaluation = resolve;
          });

          export default {
            async fetch() {
              if (++requestCount === 2) releaseEvaluation();
              return new Response((await import('./dynamic-io.js')).default);
            },
          };
        `,
        'dynamic-io.js': `
          import { evaluationBarrier } from './main.js';
          const fetchResult = await (await fetch('data:text/plain,fetched')).text();
          await evaluationBarrier;
          const timerResult = await new Promise((resolve) => {
            setTimeout(() => resolve('timer'), 1);
          });
          const randomLength = crypto.randomUUID().length;
          export default fetchResult + ':' + timerResult + ':' + randomLength;
        `,
      },
    });

    const responses = await Promise.all([
      worker.getEntrypoint().fetch('https://example.com/'),
      worker.getEntrypoint().fetch('https://example.com/'),
    ]);
    assert.deepStrictEqual(
      await Promise.all(responses.map((response) => response.text())),
      ['fetched:timer:36', 'fetched:timer:36']
    );
  },
};

// Without the flag, a dynamic worker's runtime import() evaluates outside the
// request's IoContext like any other worker, so top-level I/O fails.
export const runtimeDynamicImportIoRequiresFlag = {
  async test(ctrl, env) {
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      compatibilityFlags: ['new_module_registry'],
      allowExperimental: true,
      mainModule: 'main.js',
      modules: {
        'main.js': `
          export default {
            async fetch() {
              return new Response((await import('./dynamic-io.js')).default);
            },
          };
        `,
        'dynamic-io.js': `
          await fetch('data:text/plain,fetched');
          export default 'unexpected-success';
        `,
      },
    });

    await assert.rejects(worker.getEntrypoint().fetch('https://example.com/'), {
      message: /Disallowed operation called within global scope/,
    });
  },
};

// Deferred startup runs module scope inside an IoContext that ends when startup completes.
// Promises created there must stay usable: a request can settle one, and continuations
// attached at module scope must run. If startup tagged its promises, settling one from a
// request would defer to the finished startup context and the continuation would be dropped.
export const asyncStartupModuleScopePromiseSettledByRequest = {
  async test(ctrl, env) {
    for (const [name, extraFlags] of [
      ['moduleScopePromiseLegacy', []],
      ['moduleScopePromiseNew', ['new_module_registry']],
    ]) {
      const worker = env.loader.get(name, () => ({
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['dynamic_worker_async_startup', ...extraFlags],
        allowExperimental: true,
        mainModule: 'main.js',
        modules: {
          'main.js': `
            let release;
            const ready = new Promise((resolve) => {
              release = resolve;
            });
            let observed = 'pending';
            ready.then((value) => {
              observed = value;
            });

            export default {
              async fetch() {
                release('released');
                await ready;
                return new Response(observed);
              },
            };
          `,
        },
      }));

      const response = await worker
        .getEntrypoint()
        .fetch('https://example.com/');
      assert.strictEqual(await response.text(), 'released');
    }
  },
};

export const asyncStartupRejection = {
  async test(ctrl, env) {
    for (const [name, extraFlags] of [
      ['asyncStartupRejectionLegacy', []],
      ['asyncStartupRejectionNew', ['new_module_registry']],
    ]) {
      const worker = env.loader.get(name, () => ({
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['dynamic_worker_async_startup', ...extraFlags],
        allowExperimental: true,
        mainModule: 'main.js',
        modules: {
          'main.js': `
            await Promise.reject(new Error('startup rejection'));
            export default { fetch() {} };
          `,
        },
      }));

      await assert.rejects(
        worker.getEntrypoint().fetch('https://example.com/'),
        { message: /startup rejection/ }
      );
    }
  },
};

export const asyncStartupRequiresFlag = {
  async test(ctrl, env) {
    const worker = env.loader.get('asyncStartupRequiresFlag', () => ({
      compatibilityDate: '2025-01-01',
      mainModule: 'main.js',
      modules: {
        'main.js': `
          await new Promise((resolve) => setTimeout(resolve, 1));
          export default { fetch() {} };
        `,
      },
    }));

    await assert.rejects(worker.getEntrypoint().fetch('https://example.com/'), {
      message: /Disallowed operation called within global scope/,
    });
  },
};

export const asyncStartupFlagIsExperimental = {
  test(ctrl, env) {
    assert.throws(
      () =>
        env.loader.load({
          compatibilityDate: '2025-01-01',
          compatibilityFlags: ['dynamic_worker_async_startup'],
          mainModule: 'main.js',
          modules: { 'main.js': 'export default { fetch() {} };' },
        }),
      /dynamic_worker_async_startup is experimental/
    );
  },
};

export const startupEvalPermissionEnds = {
  async test(ctrl, env) {
    const worker = env.loader.get('startupEvalPermissionEnds', () => ({
      compatibilityDate: '2025-01-01',
      compatibilityFlags: [
        'allow_eval_during_startup',
        'dynamic_worker_async_startup',
      ],
      allowExperimental: true,
      mainModule: 'main.js',
      modules: {
        'main.js': `
          const startupResult = eval("'startup-eval'");

          export default {
            fetch() {
              try {
                eval("'runtime-eval'");
                return new Response(startupResult + ':unexpected-success');
              } catch (error) {
                return new Response(startupResult + ':' + error.name);
              }
            },
          };
        `,
      },
    }));

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.strictEqual(await response.text(), 'startup-eval:EvalError');
  },
};

export const abortDuringAsyncStartup = {
  async test(ctrl, env) {
    const worker = env.loader.get('abortDuringAsyncStartup', () => ({
      compatibilityDate: '2025-01-01',
      compatibilityFlags: ['dynamic_worker_async_startup'],
      allowExperimental: true,
      mainModule: 'main.js',
      modules: {
        'main.js': `
          import { abortIsolate } from 'cloudflare:workers';
          abortIsolate('abort during startup');
          export default { fetch() {} };
        `,
      },
    }));

    await assert.rejects(worker.getEntrypoint().fetch('https://example.com/'));
  },
};

export const asyncStartupModuleFallback = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
      ],
      mainModule: 'main.js',
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.strictEqual(await response.text(), 'fallback:42:true');
    assert.strictEqual(moduleFallbackRequests.length, 3);
    assert.deepStrictEqual(moduleFallbackRequests[0], {
      type: 'internal',
      specifier: 'file:///bundle/main.js',
      rawSpecifier: 'main.js',
      referrer: 'file:///bundle/',
    });
    // The main module's two static imports are fetched as one batch, so their
    // arrival order is not fixed.
    const batch = moduleFallbackRequests
      .slice(1)
      .sort((left, right) => left.specifier.localeCompare(right.specifier));
    assert.deepStrictEqual(batch, [
      {
        type: 'import',
        specifier: 'file:///bundle/message.js',
        rawSpecifier: './message.js',
        referrer: 'file:///bundle/main.js',
      },
      {
        type: 'import',
        specifier: 'file:///bundle/value.json',
        rawSpecifier: './value.json',
        referrer: 'file:///bundle/main.js',
        attributes: [{ name: 'type', value: 'json' }],
      },
    ]);
  },
};

// The main module's static graph is fetched one level at a time, with every miss in a
// level requested concurrently, the same way a runtime dynamic import fetches it.
export const asyncStartupFetchesStaticGraphLevelsTogether = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    activeModuleFallbackRequests = 0;
    maxActiveModuleFallbackRequests = 0;
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
      ],
      mainModule: 'fanout-main.js',
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.strictEqual(await response.text(), 'a-child:b:c');

    // The main module, then its three imports as a batch, then the dependency one
    // of them introduced. Every module is fetched exactly once.
    assert.strictEqual(moduleFallbackRequests.length, 5);
    assert.deepStrictEqual(moduleFallbackRequests[0], {
      type: 'internal',
      specifier: 'file:///bundle/fanout-main.js',
      rawSpecifier: 'fanout-main.js',
      referrer: 'file:///bundle/',
    });
    const batch = moduleFallbackRequests
      .slice(1, 4)
      .sort((left, right) => left.specifier.localeCompare(right.specifier));
    assert.deepStrictEqual(
      batch,
      ['a', 'b', 'c'].map((name) => ({
        type: 'import',
        specifier: `file:///bundle/fanout-${name}.js`,
        rawSpecifier: `./fanout-${name}.js`,
        referrer: 'file:///bundle/fanout-main.js',
      }))
    );
    assert.deepStrictEqual(moduleFallbackRequests[4], {
      type: 'import',
      specifier: 'file:///bundle/fanout-a-child.js',
      rawSpecifier: './fanout-a-child.js',
      referrer: 'file:///bundle/fanout-a.js',
    });
    assert.strictEqual(maxActiveModuleFallbackRequests, 3);
  },
};

export const asyncStartupModuleFallbackPrefersBundle = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
      ],
      mainModule: 'main.js',
      modules: {
        'main.js': `
          import { local } from './local.js';
          import { remote } from './remote.js';

          export default {
            fetch() {
              return new Response(local + ':' + remote);
            },
          };
        `,
        'local.js': "export const local = 'local';",
      },
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.strictEqual(await response.text(), 'local:remote');
    assert.deepStrictEqual(
      moduleFallbackRequests.map(({ specifier }) => specifier),
      ['file:///bundle/remote.js']
    );
  },
};

export const unsafeEvalFallbackOnlyImports = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
        'nodejs_compat',
        'unsafe_module',
      ],
      mainModule: 'main.js',
      modules: {
        'main.js': `
          import unsafeEval from 'workerd:unsafe-eval';

          export default {
            async fetch() {
              const bundled = await unsafeEval.eval(
                "import('./fallback-only.js')",
                'file:///bundle/eval.js'
              );
              const fallback = await unsafeEval.eval(
                "import('./fallback-only.js')",
                'file:///bundle/eval.js',
                true
              );
              const explicitFalse = await unsafeEval.eval(
                "import('./fallback-only.js')",
                'file:///bundle/eval.js',
                false
              );
              const normalFirstNormal = await unsafeEval.eval(
                "import('./identity-normal-first.js')",
                'file:///bundle/eval.js'
              );
              const normalFirstFallback = await unsafeEval.eval(
                "import('./identity-normal-first.js')",
                'file:///bundle/eval.js',
                true
              );
              const fallbackFirstFallback = await unsafeEval.eval(
                "import('./identity-fallback-first.js')",
                'file:///bundle/eval.js',
                true
              );
              const fallbackFirstNormal = await unsafeEval.eval(
                "import('./identity-fallback-first.js')",
                'file:///bundle/eval.js'
              );
              const referrerless = await unsafeEval.eval(
                "import('./referrerless.js')",
                undefined,
                true
              );
              const relative = await unsafeEval.eval(
                "import('./fallback-relative.js')",
                'file:///bundle/referrer/eval.js',
                true
              );
              let builtinRejected = false;
              try {
                await unsafeEval.eval(
                  "import('workerd:unsafe-eval')",
                  'file:///bundle/eval.js',
                  true
                );
              } catch {
                builtinRejected = true;
              }
              let nodeProcessRejected = false;
              try {
                await unsafeEval.eval(
                  "import('node:process')",
                  'file:///bundle/eval.js',
                  true
                );
              } catch {
                nodeProcessRejected = true;
              }
              let transitiveStaticBuiltinRejected = false;
              try {
                await unsafeEval.eval(
                  "import('./static-builtin.js')",
                  'file:///bundle/eval.js',
                  true
                );
              } catch {
                transitiveStaticBuiltinRejected = true;
              }
              let invalidReferrerRejected = false;
              try {
                await unsafeEval.eval(
                  "import('./fallback-only.js')",
                  'not a URL',
                  true
                );
              } catch {
                invalidReferrerRejected = true;
              }
              let commonJsRejected = false;
              try {
                await unsafeEval.eval(
                  "import('./fallback-cjs.js')",
                  'file:///bundle/eval.js',
                  true
                );
              } catch {
                commonJsRejected = true;
              }

              return Response.json({
                bundled: bundled.default,
                fallback: fallback.default,
                explicitFalse: explicitFalse.default,
                normalFirst: {
                  normal: normalFirstNormal.default.dependency,
                  fallback: normalFirstFallback.default.dependency,
                  distinct: normalFirstNormal !== normalFirstFallback,
                },
                fallbackFirst: {
                  fallback: fallbackFirstFallback.default.dependency,
                  normal: fallbackFirstNormal.default.dependency,
                  distinct: fallbackFirstFallback !== fallbackFirstNormal,
                },
                referrerless: referrerless.default,
                relative: relative.default,
                builtinRejected,
                nodeProcessRejected,
                transitiveStaticBuiltinRejected,
                invalidReferrerRejected,
                commonJsRejected,
              });
            },
          };
        `,
        'fallback-only.js': "export default 'bundle';",
        'transitive.js': "export default 'bundle-dependency';",
        'dynamic-transitive.js': "export default 'bundle-dynamic';",
        'identity-dependency.js': "export default 'bundle-identity';",
      },
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.deepStrictEqual(await response.json(), {
      bundled: 'bundle',
      fallback: 'fallback:fallback-dependency:fallback-dynamic:true',
      explicitFalse: 'bundle',
      normalFirst: {
        normal: 'bundle-identity',
        fallback: 'fallback-identity',
        distinct: true,
      },
      fallbackFirst: {
        fallback: 'fallback-identity',
        normal: 'bundle-identity',
        distinct: true,
      },
      referrerless: 'referrerless:dependency:timer',
      relative: 'relative',
      builtinRejected: true,
      nodeProcessRejected: true,
      transitiveStaticBuiltinRejected: true,
      invalidReferrerRejected: true,
      commonJsRejected: true,
    });
    assert.deepStrictEqual(
      moduleFallbackRequests.map(({ specifier }) => specifier),
      [
        'file:///bundle/fallback-only.js',
        'file:///bundle/transitive.js',
        'file:///bundle/dynamic-transitive.js',
        'workerd:unsafe-eval',
        'file:///bundle/identity-normal-first.js',
        'file:///bundle/identity-dependency.js',
        'file:///bundle/identity-fallback-first.js',
        'file:///bundle/referrerless.js',
        'file:///bundle/referrerless-dependency.js',
        'file:///bundle/referrer/fallback-relative.js',
        'workerd:unsafe-eval',
        'node:process',
        'file:///bundle/static-builtin.js',
        'workerd:unsafe-eval',
        'file:///bundle/fallback-cjs.js',
      ]
    );
  },
};

export const moduleFallbackBinaryResponses = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
      ],
      mainModule: 'main.js',
      modules: {
        'main.js': `
          import source addSource from './add.wasm';
          import addDefault from './add.wasm';
          import payload from './payload.bin';

          const startupAdd = new WebAssembly.Instance(addSource).exports.add;

          export default {
            async fetch() {
              const runtimeSource = await import.source('./add-runtime.wasm');
              const runtimeAdd = new WebAssembly.Instance(runtimeSource).exports.add;
              const runtimePayload = (await import('./payload-runtime.bin')).default;
              return Response.json({
                startupIsModule: addSource instanceof WebAssembly.Module,
                defaultIsModule: addDefault instanceof WebAssembly.Module,
                startupSum: startupAdd(2, 3),
                startupPayload: Array.from(new Uint8Array(payload)),
                runtimeIsModule: runtimeSource instanceof WebAssembly.Module,
                runtimeSum: runtimeAdd(40, 2),
                runtimePayload: Array.from(new Uint8Array(runtimePayload)),
              });
            },
          };
        `,
      },
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.deepStrictEqual(await response.json(), {
      startupIsModule: true,
      defaultIsModule: true,
      startupSum: 5,
      startupPayload: [1, 2, 3, 4],
      runtimeIsModule: true,
      runtimeSum: 42,
      runtimePayload: [1, 2, 3, 4],
    });
    assert.deepStrictEqual(
      moduleFallbackRequests.map(({ specifier }) => specifier),
      [
        'file:///bundle/add.wasm',
        'file:///bundle/payload.bin',
        'file:///bundle/add-runtime.wasm',
        'file:///bundle/payload-runtime.bin',
      ]
    );
  },
};

export const asyncStartupModuleFallbackRequiresAllFlags = {
  test(ctrl, env, ctx) {
    const requiredFlags = [
      'allow_insecure_inefficient_logged_eval',
      'dynamic_worker_async_startup',
      'new_module_registry',
    ];
    for (const omittedFlag of requiredFlags) {
      assert.throws(
        () =>
          env.loader.load({
            compatibilityDate: '2025-01-01',
            allowExperimental: true,
            compatibilityFlags: requiredFlags.filter(
              (flag) => flag !== omittedFlag
            ),
            mainModule: 'main.js',
            globalOutbound: ctx.exports.Outbound({}),
          }),
        /Dynamic Worker code must contain at least one module/
      );
    }
  },
};

export const runtimeDynamicImportModuleFallback = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    activeModuleFallbackRequests = 0;
    maxActiveModuleFallbackRequests = 0;
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
        'nodejs_compat',
      ],
      mainModule: 'main.js',
      modules: {
        'main.js': `
          import { createRequire } from 'node:module';
          const require = createRequire(import.meta.url);

          export default {
            async fetch() {
              const { value, moduleUrl, resolvedNested, loadNested } =
                await import('./runtime-redirect.js');
              const nested = await loadNested();
              const json = await import('./runtime-value.json', {
                with: { type: 'json' },
              });
              const query = await import('./runtime-query.js?version=1');
              const nestedQuery = await query.loadNestedQuery();
              const concurrent = await Promise.all([
                import('./concurrent-a.js'),
                import('./concurrent-b.js'),
              ]);
              let requireResult = 'unexpected-success';
              try {
                require('./runtime-value.json');
              } catch (error) {
                if (error.message.includes('Module not found')) {
                  requireResult = 'require-blocked';
                }
              }
              return new Response(
                value + ':' + nested + ':' + moduleUrl + ':' + resolvedNested + ':' +
                json.default.answer + ':' + query.default + ':' + nestedQuery + ':' +
                concurrent.map(({ default: item }) => item).join('') + ':' + requireResult
              );
            },
          };
        `,
      },
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.strictEqual(
      await response.text(),
      'runtime:dependency:nested:file:///canonical/runtime.js:' +
        'file:///canonical/runtime-nested.js:42:query:nested-query:ab:require-blocked'
    );
    assert.deepStrictEqual(moduleFallbackRequests.slice(0, 7), [
      {
        type: 'import',
        specifier: 'file:///bundle/runtime-redirect.js',
        rawSpecifier: './runtime-redirect.js',
        referrer: 'file:///bundle/main.js',
      },
      {
        type: 'import',
        specifier: 'file:///canonical/runtime.js',
        rawSpecifier: './runtime-redirect.js',
        referrer: 'file:///bundle/main.js',
      },
      {
        type: 'import',
        specifier: 'file:///canonical/runtime-dependency.js',
        rawSpecifier: './runtime-dependency.js',
        referrer: 'file:///canonical/runtime.js',
      },
      {
        type: 'import',
        specifier: 'file:///canonical/runtime-nested.js',
        rawSpecifier: './runtime-nested.js',
        referrer: 'file:///canonical/runtime.js',
      },
      {
        type: 'import',
        specifier: 'file:///bundle/runtime-value.json',
        rawSpecifier: './runtime-value.json',
        referrer: 'file:///bundle/main.js',
        attributes: [{ name: 'type', value: 'json' }],
      },
      {
        type: 'import',
        specifier: 'file:///bundle/runtime-query.js?version=1',
        rawSpecifier: './runtime-query.js?version=1',
        referrer: 'file:///bundle/main.js',
      },
      {
        type: 'import',
        specifier: 'file:///bundle/runtime-query-child.js?version=2',
        rawSpecifier: './runtime-query-child.js?version=2',
        referrer: 'file:///bundle/runtime-query.js?version=1',
      },
    ]);
    assert.deepStrictEqual(
      moduleFallbackRequests.slice(7).map(({ specifier }) => specifier),
      ['file:///bundle/concurrent-a.js', 'file:///bundle/concurrent-b.js']
    );
    assert.strictEqual(maxActiveModuleFallbackRequests, 2);
  },
};

// A dynamically imported module's static dependencies are fetched together, one
// graph level at a time, rather than one dependency per instantiation attempt.
export const runtimeDynamicImportFetchesStaticGraphLevelsTogether = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    activeModuleFallbackRequests = 0;
    maxActiveModuleFallbackRequests = 0;
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
      ],
      mainModule: 'main.js',
      modules: {
        'main.js': `
          export default {
            async fetch() {
              const { default: value } = await import('./fanout.js');
              return new Response(value);
            },
          };
        `,
      },
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.strictEqual(await response.text(), 'a-child:b:c');

    // Every module is fetched exactly once: the root, then its three imports as a
    // batch, then the dependency one of them introduced.
    assert.strictEqual(moduleFallbackRequests.length, 5);
    assert.strictEqual(
      moduleFallbackRequests[0].specifier,
      'file:///bundle/fanout.js'
    );
    // The batch is issued concurrently, so its arrival order is not fixed. Each
    // entry carries the same referrer and raw specifier that instantiation
    // would have reported for it.
    const batch = moduleFallbackRequests
      .slice(1, 4)
      .sort((left, right) => left.specifier.localeCompare(right.specifier));
    assert.deepStrictEqual(
      batch,
      ['a', 'b', 'c'].map((name) => ({
        type: 'import',
        specifier: `file:///bundle/fanout-${name}.js`,
        rawSpecifier: `./fanout-${name}.js`,
        referrer: 'file:///bundle/fanout.js',
      }))
    );
    assert.deepStrictEqual(moduleFallbackRequests[4], {
      type: 'import',
      specifier: 'file:///bundle/fanout-a-child.js',
      rawSpecifier: './fanout-a-child.js',
      referrer: 'file:///bundle/fanout-a.js',
    });
    assert.strictEqual(maxActiveModuleFallbackRequests, 3);
  },
};

const POLYFILL_GRAPH_FLAGS = [
  'allow_insecure_inefficient_logged_eval',
  'dynamic_worker_async_startup',
  'new_module_registry',
];

// The polyfill graph, every module served by the fallback:
//
//   entry -> consumer-a -> conditionally-load-polyfill --(top-level await import)--> popover-polyfill
//         -> consumer-b -> conditionally-load-polyfill
//         -> conditionally-load-polyfill
//
// The static part is fetched one level at a time; the polyfill itself is fetched by
// the dynamic import inside the gate's top-level await, after the graph has started
// evaluating. Both consumers observe the polyfill because their bodies run only after
// the gate settles.
function assertPolyfillGraphFetched(requests) {
  assert.deepStrictEqual(requests.slice(0, 3).sort(), [
    'file:///bundle/conditionally-load-polyfill.js',
    'file:///bundle/polyfill-consumer-a.js',
    'file:///bundle/polyfill-consumer-b.js',
  ]);
  assert.deepStrictEqual(requests.slice(3), [
    'file:///bundle/popover-polyfill.js',
  ]);
}

export const asyncStartupConditionalPolyfill = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: POLYFILL_GRAPH_FLAGS,
      mainModule: 'polyfill-main.js',
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.strictEqual(await response.text(), 'true:true:2');

    const requests = moduleFallbackRequests.map(({ specifier }) => specifier);
    assert.deepStrictEqual(requests.slice(0, 2), [
      'file:///bundle/polyfill-main.js',
      'file:///bundle/polyfill-entry.js',
    ]);
    assertPolyfillGraphFetched(requests.slice(2));
  },
};

export const runtimeDynamicImportConditionalPolyfill = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: POLYFILL_GRAPH_FLAGS,
      mainModule: 'main.js',
      modules: {
        'main.js': `
          export default {
            async fetch() {
              return new Response((await import('./polyfill-entry.js')).default);
            },
          };
        `,
      },
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.strictEqual(await response.text(), 'true:true:2');

    const requests = moduleFallbackRequests.map(({ specifier }) => specifier);
    assert.deepStrictEqual(requests.slice(0, 1), [
      'file:///bundle/polyfill-entry.js',
    ]);
    assertPolyfillGraphFetched(requests.slice(1));
  },
};

// Concurrent imports whose static graphs share a missing dependency issue one fetch
// for it: the later import waits on the fetch the earlier one started.
export const runtimeDynamicImportsShareInFlightFetches = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
      ],
      mainModule: 'main.js',
      modules: {
        'main.js': `
          export default {
            async fetch() {
              const [a, b] = await Promise.all([
                import('./shared-a.js'),
                import('./shared-b.js'),
              ]);
              return new Response(a.default + '|' + b.default);
            },
          };
        `,
      },
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.strictEqual(await response.text(), 'a:dep|b:dep');
    assert.deepStrictEqual(
      moduleFallbackRequests.map(({ specifier }) => specifier).sort(),
      [
        'file:///bundle/shared-a.js',
        'file:///bundle/shared-b.js',
        'file:///bundle/shared-dep.js',
      ]
    );
  },
};

// When one fetch in a batch fails, the import rejects with that failure and the
// other fetches in the batch are still issued exactly once.
export const runtimeDynamicImportRejectsWhenBatchedFetchFails = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
      ],
      mainModule: 'main.js',
      modules: {
        'main.js': `
          export default {
            async fetch() {
              try {
                await import('./fanout-broken.js');
                return new Response('unexpected-success');
              } catch (error) {
                // The sibling fetches are still in flight when the import rejects.
                // Let them finish so the test can observe the complete request set.
                await new Promise((resolve) => setTimeout(resolve, 50));
                return new Response(error.message);
              }
            },
          };
        `,
      },
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.match(
      await response.text(),
      /Dynamic module fallback failed for file:\/\/\/bundle\/fanout-missing\.js with status 404/
    );
    assert.deepStrictEqual(
      moduleFallbackRequests.map(({ specifier }) => specifier).sort(),
      [
        'file:///bundle/fanout-a.js',
        'file:///bundle/fanout-broken.js',
        'file:///bundle/fanout-c.js',
        'file:///bundle/fanout-missing.js',
      ]
    );
  },
};

export const runtimeDynamicImportModuleFallbackQueryIdentity = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
      ],
      mainModule: 'main.js',
      modules: {
        'main.js': `
          export default {
            async fetch() {
              const first = await import('./query-identity.js?version=1');
              const repeated = await import('./query-identity.js?version=1');
              const second = await import('./query-identity.js?version=2');
              const redirected = await import('./queryless-redirect.js?version=1');
              return Response.json({
                repeated: first === repeated,
                distinct: first !== second,
                versions: [first.version, second.version],
                urls: [first.url, second.url],
                redirected: redirected.default,
                redirectedUrl: redirected.url,
              });
            },
          };
        `,
      },
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.deepStrictEqual(await response.json(), {
      repeated: true,
      distinct: true,
      versions: [1, 2],
      urls: [
        'file:///bundle/query-identity.js?version=1',
        'file:///bundle/query-identity.js?version=2',
      ],
      redirected: 'redirected',
      redirectedUrl: 'file:///bundle/queryless-redirect.js',
    });
    assert.deepStrictEqual(
      moduleFallbackRequests.map(({ specifier }) => specifier),
      [
        'file:///bundle/query-identity.js?version=1',
        'file:///bundle/query-identity.js?version=2',
        'file:///bundle/queryless-redirect.js?version=1',
        'file:///bundle/queryless-redirect.js',
      ]
    );
  },
};

export const runtimeDynamicImportFallbackRedirectCycle = {
  async test(ctrl, env, ctx) {
    moduleFallbackRequests = [];
    const worker = env.loader.load({
      compatibilityDate: '2025-01-01',
      allowExperimental: true,
      compatibilityFlags: [
        'allow_insecure_inefficient_logged_eval',
        'dynamic_worker_async_startup',
        'new_module_registry',
      ],
      mainModule: 'main.js',
      modules: {
        'main.js': `
          export default {
            async fetch() {
              try {
                await import('./redirect-cycle-a.js?version=1');
                return new Response('loaded');
              } catch {
                return new Response('cycle-rejected');
              }
            },
          };
        `,
      },
      globalOutbound: ctx.exports.Outbound({}),
    });

    const response = await worker.getEntrypoint().fetch('https://example.com/');
    assert.strictEqual(await response.text(), 'cycle-rejected');
    assert.deepStrictEqual(
      moduleFallbackRequests.map(({ specifier }) => specifier),
      [
        'file:///bundle/redirect-cycle-a.js?version=1',
        'file:///bundle/redirect-cycle-b.js?version=2',
      ]
    );
  },
};
