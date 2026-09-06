// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
import assert from 'node:assert';
import { WorkerEntrypoint } from 'cloudflare:workers';

let outboundRequests = 0;
let sourceRequests = 0;

export class Outbound extends WorkerEntrypoint {
  fetch() {
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
          const evalResult = eval("'eval'");
          const dynamicImportResult = ${dynamicImportSource};

          export default {
            fetch() {
              return new Response(
                  timerResult + ':' + fetchResult + ':' + capabilityResult + ':' +
                  evalResult + ':' + dynamicImportResult);
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
      'timer:fetched:fetched:eval' +
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
        compatibilityFlags: [
          'dynamic_worker_async_startup',
          ...extraFlags,
        ],
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
