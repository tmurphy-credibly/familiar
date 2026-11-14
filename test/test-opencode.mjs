// Tests for the opencode plugin, driving both plugin APIs with fake opencode objects.
// Run: node test/test-opencode.mjs
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import plugin from '../opencode/familiar.js';
import {buildConfig, resolveEvent, sessionLabel} from '../extension/familiar@tmurphy-credibly.github.io/config.js';

const {toolDetail, createRecorder, setupV2, serverV1} = plugin[Symbol.for('familiar.internals')];
const {config} = buildConfig({});
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (e) {
        failed++;
        console.log(`FAIL ${name}: ${e.stack}`);
    }
}

function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'pet-opencode-'));
    const recorder = createRecorder({dir, now: () => 1000});
    const read = id => {
        try {
            return JSON.parse(readFileSync(join(dir, `opencode-${id}.json`), 'utf8'));
        } catch {
            return null;
        }
    };
    const mood = id => resolveEvent(config, read(id), null).mood;
    return {dir, recorder, read, mood, files: () => readdirSync(dir), done: () => rmSync(dir, {recursive: true, force: true})};
}

// A fake opencode 2.x plugin context: hooks are captured, events are pushed by the test.
function fakeV2(directory) {
    const hooks = {};
    const queue = [];
    let wake = null;
    const ctx = {
        location: {directory},
        tool: {hook: async (name, cb) => ((hooks[name] = cb), {dispose: () => delete hooks[name]})},
        event: {
            subscribe: ({signal}) => ({
                async *[Symbol.asyncIterator]() {
                    while (!signal.aborted) {
                        if (queue.length)
                            yield queue.shift();
                        else
                            await new Promise(r => (wake = r));
                    }
                },
            }),
        },
    };
    const emit = async (type, data, location = {directory}) => {
        queue.push({type, data, location});
        wake?.();
        await new Promise(r => setTimeout(r, 5));
    };
    return {ctx, hooks, emit};
}

await test('the module exports only the plugin object', async () => {
    const mod = await import('../opencode/familiar.js');
    assert.deepEqual(Object.keys(mod), ['default']);
    assert.equal(plugin.id, 'familiar');
    assert.equal(typeof plugin.setup, 'function');
    assert.equal(typeof plugin.server, 'function');
    assert.deepEqual(Object.keys(plugin).sort(), ['id', 'server', 'setup']);
});

await test('tool detail matches the Claude hook', () => {
    assert.equal(toolDetail('shell', {command: 'npm   test\n --watch'}), 'npm test --watch');
    assert.equal(toolDetail('bash', {command: 'ls'}), 'ls');
    assert.equal(toolDetail('edit', {path: '/a/b/extension.js'}), 'extension.js');
    assert.equal(toolDetail('read', {filePath: '/a/b/README.md'}), 'README.md');
    assert.equal(toolDetail('grep', {pattern: 'TODO'}), 'TODO');
    assert.equal(toolDetail('webfetch', {url: 'https://example.com'}), 'https://example.com');
    assert.equal(toolDetail('subagent', {description: 'Find the bug'}), 'Find the bug');
    assert.equal(toolDetail('x', null), '');
});

await test('v2: a whole turn maps to the standard moods', async () => {
    const s = sandbox();
    const {ctx, hooks, emit} = fakeV2('/home/me/code/my-app');
    const cleanup = await setupV2(ctx, s.recorder);
    await emit('session.created', {sessionID: 'ses_1', location: {directory: '/home/me/code/my-app'}});
    assert.equal(s.mood('ses_1'), 'idle');
    assert.equal(s.read('ses_1').project, 'my-app');
    assert.equal(s.read('ses_1').agent, 'opencode');
    await emit('session.execution.started', {sessionID: 'ses_1'});
    assert.equal(s.mood('ses_1'), 'thinking');
    await hooks['execute.before']({tool: 'shell', sessionID: 'ses_1', input: {command: 'npm test'}});
    const working = resolveEvent(config, s.read('ses_1'), null);
    assert.deepEqual([working.mood, working.text, working.detail], ['working', 'Running shell', 'npm test']);
    await emit('permission.asked', {id: 'p1', sessionID: 'ses_1', action: 'shell', resources: ['npm test']});
    assert.equal(resolveEvent(config, s.read('ses_1'), null).text, 'Can I run shell?');
    await emit('permission.replied', {sessionID: 'ses_1', requestID: 'p1', reply: 'once'});
    assert.equal(s.mood('ses_1'), 'working');
    await hooks['execute.after']({tool: 'shell', sessionID: 'ses_1', status: 'completed', result: {}});
    assert.equal(s.mood('ses_1'), 'thinking');
    await hooks['execute.after']({tool: 'edit', sessionID: 'ses_1', status: 'error', error: {message: 'no match'}});
    assert.equal(s.mood('ses_1'), 'error');
    await emit('session.execution.succeeded', {sessionID: 'ses_1'});
    assert.equal(s.mood('ses_1'), 'done');
    await cleanup();
    assert.deepEqual(s.files(), [], 'cleanup removes the session files');
    s.done();
});

await test('v2: failures, questions, rejections, deletes and subagents', async () => {
    const s = sandbox();
    const {ctx, hooks, emit} = fakeV2('/p/app');
    const cleanup = await setupV2(ctx, s.recorder);
    await emit('session.execution.started', {sessionID: 'a'});
    await emit('form.created', {form: {id: 'f', sessionID: 'a', title: 'Which database?', fields: []}});
    const asked = resolveEvent(config, s.read('a'), null);
    assert.deepEqual([asked.mood, asked.text], ['needs', 'Which database?']);
    await emit('form.replied', {id: 'f', sessionID: 'a', answer: {}});
    assert.equal(s.mood('a'), 'thinking');
    await hooks['execute.before']({tool: 'shell', sessionID: 'a', input: {command: 'rm -rf x'}});
    await emit('permission.asked', {id: 'p', sessionID: 'a', action: 'shell', resources: ['rm -rf x']});
    await emit('permission.replied', {sessionID: 'a', requestID: 'p', reply: 'reject'});
    assert.equal(s.mood('a'), 'thinking');
    await emit('session.execution.failed', {sessionID: 'a', error: {type: 'api', message: 'rate limited'}});
    assert.equal(s.mood('a'), 'error');
    assert.equal(s.read('a').message, 'rate limited');
    await emit('session.idle', {sessionID: 'a'});
    assert.equal(s.mood('a'), 'error', 'idle after a failure keeps the error');

    await emit('session.created', {sessionID: 'child', parentID: 'a', location: {directory: '/p/app'}});
    await hooks['execute.before']({tool: 'read', sessionID: 'child', input: {path: '/p/app/x.js'}});
    assert.equal(s.read('child'), null, 'subagent sessions are not shown');

    await emit('session.deleted', {sessionID: 'a'});
    assert.equal(s.read('a'), null);
    await emit('session.execution.started', {sessionID: 'b'});
    await emit('session.execution.interrupted', {sessionID: 'b', reason: 'user'});
    assert.equal(s.mood('b'), 'done');
    await emit('session.execution.interrupted', {sessionID: 'b', reason: 'shutdown'});
    assert.equal(s.read('b'), null);
    await cleanup();
    s.done();
});

await test('v1: hooks and events map to the standard moods', async () => {
    const s = sandbox();
    const hooks = await serverV1({directory: '/home/me/code/legacy'}, {}, s.recorder);
    await hooks.event({event: {type: 'session.created', properties: {info: {id: 'ses_9', directory: '/home/me/code/legacy'}}}});
    assert.equal(s.mood('ses_9'), 'idle');
    assert.equal(s.read('ses_9').project, 'legacy');
    await hooks['chat.message']({sessionID: 'ses_9'}, {});
    assert.equal(s.mood('ses_9'), 'thinking');
    await hooks['tool.execute.before']({tool: 'bash', sessionID: 'ses_9', callID: 'c'}, {args: {command: 'make'}});
    assert.equal(resolveEvent(config, s.read('ses_9'), null).detail, 'make');
    await hooks.event({event: {type: 'permission.updated', properties: {id: 'p', type: 'bash', pattern: 'make', sessionID: 'ses_9', title: 'Run make'}}});
    assert.equal(resolveEvent(config, s.read('ses_9'), null).text, 'Can I run bash?');
    await hooks.event({event: {type: 'permission.replied', properties: {sessionID: 'ses_9', permissionID: 'p', response: 'once'}}});
    assert.equal(s.mood('ses_9'), 'working');
    await hooks['tool.execute.after']({tool: 'bash', sessionID: 'ses_9', callID: 'c', args: {}}, {title: '', output: '', metadata: {}});
    assert.equal(s.mood('ses_9'), 'thinking');
    await hooks.event({event: {type: 'message.part.updated', properties: {part: {type: 'tool', tool: 'edit', sessionID: 'ses_9', state: {status: 'error', error: 'old string not found'}}}}});
    assert.equal(s.mood('ses_9'), 'error');
    await hooks.event({event: {type: 'session.idle', properties: {sessionID: 'ses_9'}}});
    assert.equal(s.mood('ses_9'), 'done');
    await hooks.event({event: {type: 'session.error', properties: {sessionID: 'ses_9', error: {name: 'UnknownError', data: {message: 'boom'}}}}});
    await hooks.event({event: {type: 'session.idle', properties: {sessionID: 'ses_9'}}});
    assert.equal(s.mood('ses_9'), 'error', 'idle after session.error keeps the error');
    await hooks['chat.message']({sessionID: 'ses_9'}, {});
    await hooks.event({event: {type: 'session.error', properties: {sessionID: 'ses_9', error: {name: 'MessageAbortedError', data: {message: 'aborted'}}}}});
    assert.equal(s.mood('ses_9'), 'done', 'a user abort is not an error');
    await hooks.event({event: {type: 'session.created', properties: {info: {id: 'kid', parentID: 'ses_9', directory: '/x'}}}});
    await hooks['chat.message']({sessionID: 'kid'}, {});
    assert.equal(s.read('kid'), null, 'subagent sessions are not shown');
    await hooks.event({event: {type: 'session.deleted', properties: {info: {id: 'ses_9'}}}});
    assert.equal(s.read('ses_9'), null);
    await hooks['chat.message']({sessionID: 'other'}, {});
    await hooks.dispose();
    assert.deepEqual(s.files(), [], 'dispose removes the session files');
    s.done();
});

await test('the entrypoints load once per process and again after cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pet-opencode-'));
    process.env.XDG_CACHE_HOME = dir;
    const first = await plugin.server({directory: '/x'});
    const second = await plugin.server({directory: '/x'});
    assert.ok(first['tool.execute.before'], 'first load registers hooks');
    assert.deepEqual(second, {}, 'second load in the same process is a no-op');
    await first.dispose();
    const third = await plugin.server({directory: '/x'});
    assert.ok(third['tool.execute.before'], 'reload after dispose registers again');
    await third.dispose();
    rmSync(dir, {recursive: true, force: true});
});

await test('a broken context never throws into opencode', async () => {
    assert.equal(await plugin.setup({}), undefined);
    const dir = mkdtempSync(join(tmpdir(), 'pet-opencode-'));
    writeFileSync(join(dir, 'file'), '');
    const s = createRecorder({dir: join(dir, 'file', 'sessions')});   // ENOTDIR
    s.prompt('x', '/p');   // must not throw
    rmSync(dir, {recursive: true, force: true});
});

await test('opencode sessions are labelled with their agent', () => {
    assert.equal(sessionLabel({project: 'my-app', agent: 'opencode'}), 'my-app (opencode)');
    assert.equal(sessionLabel({project: 'my-app', agent: 'claude'}), 'my-app');
    assert.equal(sessionLabel({project: 'my-app'}), 'my-app');
    assert.equal(sessionLabel({project: '', agent: 'opencode'}), 'opencode');
});

await test('rules can match on agent', () => {
    const {config: c} = buildConfig({rules: [{event: 'Stop', agent: '^opencode$', mood: 'idle'}]});
    assert.equal(resolveEvent(c, {event: 'Stop', agent: 'opencode', ts: 1}, null).mood, 'idle');
    assert.equal(resolveEvent(c, {event: 'Stop', agent: 'claude', ts: 1}, null).mood, 'done');
    assert.equal(resolveEvent(c, {event: 'Stop', ts: 1}, null).mood, 'done');
});

process.exit(failed ? 1 : 0);
