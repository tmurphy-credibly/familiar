// Tests for the Pi extension, driving it with a fake Pi API.
// Run: node test/test-pi.mjs
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import familiar from '../pi/familiar.js';
import {buildConfig, resolveEvent, sessionLabel} from '../extension/familiar@tmurphy-credibly.github.io/config.js';

const {toolDetail, runError, createTracker, register} = familiar[Symbol.for('familiar.internals')];
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

// A fake Pi: records handlers; `known` limits events like an older Pi would.
function fakePi({sessionId = 'sess-1', cwd = '/home/me/code/my-app', known = null} = {}) {
    const handlers = {};
    const pi = {
        on(event, handler) {
            if (known && !known.includes(event))
                throw new Error(`unknown event ${event}`);
            (handlers[event] ??= []).push(handler);
        },
    };
    const ctx = {cwd, sessionManager: {getSessionId: () => sessionId}};
    const emit = async (event, ev = {}, c = ctx) => {
        for (const h of handlers[event] ?? [])
            await h({type: event, ...ev}, c);
    };
    return {pi, ctx, emit, handlers};
}

// A tracker writing into a temp dir, with a timer the test fires by hand.
function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'familiar-pi-'));
    let pending = null;
    const tracker = createTracker({
        dir, now: () => 1000,
        setTimer: fn => (pending = fn),
        clearTimer: () => (pending = null),
    });
    const read = id => {
        try {
            return JSON.parse(readFileSync(join(dir, `pi-${id}.json`), 'utf8'));
        } catch {
            return null;
        }
    };
    return {
        dir, tracker, read,
        state: id => resolveEvent(config, read(id), null),
        mood: id => resolveEvent(config, read(id), null).mood,
        fireTimer: () => { const fn = pending; pending = null; fn?.(); },
        timerPending: () => pending !== null,
        files: () => readdirSync(dir),
        done: () => rmSync(dir, {recursive: true, force: true}),
    };
}

const assistant = (stopReason, errorMessage) => ({role: 'assistant', stopReason, errorMessage, content: []});

await test('the module exports only the extension factory', async () => {
    const mod = await import('../pi/familiar.js');
    assert.deepEqual(Object.keys(mod), ['default']);
    assert.equal(typeof familiar, 'function');
});

await test('tool detail matches the Claude hook', () => {
    assert.equal(toolDetail('bash', {command: 'npm   test'}), 'npm test');
    assert.equal(toolDetail('read', {path: '/a/b/README.md'}), 'README.md');
    assert.equal(toolDetail('edit', {path: 'src/x.ts', oldText: 'a', newText: 'b'}), 'x.ts');
    assert.equal(toolDetail('grep', {pattern: 'TODO'}), 'TODO');
    assert.equal(toolDetail('custom', null), '');
});

await test('run errors come from the last assistant message', () => {
    assert.equal(runError([assistant('error', 'rate limited')]), 'rate limited');
    assert.equal(runError([assistant('error', 'x'), {role: 'user'}, assistant('stop')]), null);
    assert.equal(runError([assistant('stop')]), null);
    assert.equal(runError(undefined), null);
});

await test('Pi 1.x: a whole run maps to the standard moods', async () => {
    const s = sandbox();
    const {pi, emit} = fakePi();
    register(pi, s.tracker);
    await emit('session_start', {reason: 'startup'});
    assert.equal(s.mood('sess-1'), 'idle');
    assert.deepEqual([s.read('sess-1').agent, s.read('sess-1').project], ['pi', 'my-app']);
    assert.equal(sessionLabel(s.read('sess-1')), 'my-app (pi)');
    await emit('agent_start');
    assert.equal(s.mood('sess-1'), 'thinking');
    await emit('tool_execution_start', {toolName: 'bash', toolCallId: 't1', args: {command: 'npm test'}});
    assert.deepEqual([s.state('sess-1').mood, s.state('sess-1').text, s.state('sess-1').detail], ['working', 'Running bash', 'npm test']);
    await emit('tool_execution_end', {toolName: 'bash', toolCallId: 't1', isError: false, result: {content: []}});
    assert.equal(s.mood('sess-1'), 'thinking');
    await emit('tool_execution_end', {toolName: 'edit', toolCallId: 't2', args: {path: 'a.js'}, isError: true,
        result: {content: [{type: 'text', text: 'oldText not found'}]}});
    assert.equal(s.mood('sess-1'), 'error');
    assert.equal(s.read('sess-1').message, 'oldText not found');
    await emit('agent_end', {messages: [assistant('stop')]});
    await emit('agent_settled', {aborted: false});
    assert.equal(s.mood('sess-1'), 'done');
    assert.equal(s.timerPending(), false, 'no fallback timer once agent_settled is known');
    await emit('session_shutdown', {reason: 'quit'});
    assert.deepEqual(s.files(), [], 'shutdown removes the session file');
    s.done();
});

await test('Pi 1.x: errors wait for settle, so a retry never flashes Oops', async () => {
    const s = sandbox();
    const {pi, emit} = fakePi();
    register(pi, s.tracker);
    await emit('session_start');
    await emit('agent_settled', {aborted: false});   // Pi announces it supports settle
    await emit('agent_start');
    await emit('agent_end', {messages: [assistant('error', 'overloaded')]});
    assert.equal(s.mood('sess-1'), 'thinking', 'still thinking while Pi retries');
    await emit('agent_start');                        // the retry
    await emit('agent_end', {messages: [assistant('stop')]});
    await emit('agent_settled', {aborted: false});
    assert.equal(s.mood('sess-1'), 'done', 'a successful retry ends as done');
    await emit('agent_start');
    await emit('agent_end', {messages: [assistant('error', 'quota exceeded')]});
    await emit('agent_settled', {aborted: false});
    assert.deepEqual([s.mood('sess-1'), s.read('sess-1').message], ['error', 'quota exceeded']);
    await emit('agent_start');
    await emit('agent_end', {messages: [assistant('aborted')]});
    await emit('agent_settled', {aborted: true});
    assert.equal(s.mood('sess-1'), 'done', 'Escape is not an error');
    s.done();
});

await test('Pi 1.x: an extension prompt is Needs you, then restores the state', async () => {
    const s = sandbox();
    const {pi, emit} = fakePi();
    register(pi, s.tracker);
    await emit('session_start');
    await emit('agent_start');
    await emit('tool_execution_start', {toolName: 'bash', args: {command: 'rm -rf build'}});
    await emit('ui_prompt_start', {reason: 'ui_prompt', kind: 'confirm', title: 'Allow rm -rf?'});
    assert.deepEqual([s.state('sess-1').mood, s.state('sess-1').text], ['needs', 'Allow rm -rf?']);
    await emit('ui_prompt_end', {reason: 'ui_prompt', kind: 'confirm'});
    assert.deepEqual([s.state('sess-1').mood, s.state('sess-1').detail], ['working', 'rm -rf build']);
    await emit('ui_prompt_end');   // stray end: no change
    assert.equal(s.mood('sess-1'), 'working');
    await emit('ui_prompt_start', {kind: 'select'});
    assert.equal(s.state('sess-1').text, 'Waiting for your answer');
    s.done();
});

await test('Pi 0.7x: agent_end settles after a quiet spell', async () => {
    const s = sandbox();
    const {pi, emit} = fakePi({known: ['session_start', 'agent_start', 'agent_end', 'tool_execution_start',
        'tool_execution_end', 'session_shutdown']});
    register(pi, s.tracker);   // registering unknown events must not throw
    await emit('session_start');
    await emit('agent_start');
    await emit('agent_end', {messages: [assistant('error', 'overloaded')]});
    assert.equal(s.mood('sess-1'), 'thinking');
    await emit('agent_start');   // retry arrives before the timer
    assert.equal(s.timerPending(), false, 'a new run cancels the pending settle');
    await emit('agent_end', {messages: [assistant('stop')]});
    s.fireTimer();
    assert.equal(s.mood('sess-1'), 'done');
    await emit('agent_start');
    await emit('agent_end', {messages: [assistant('error', 'bad key')]});
    s.fireTimer();
    assert.deepEqual([s.mood('sess-1'), s.read('sess-1').message], ['error', 'bad key']);
    s.done();
});

await test('sessions: /new swaps files, reload mid-session still reports', async () => {
    const s = sandbox();
    const a = fakePi({sessionId: 'old'});
    register(a.pi, s.tracker);
    await a.emit('session_start');
    await a.emit('session_shutdown', {reason: 'new'});
    assert.equal(s.read('old'), null);
    const b = fakePi({sessionId: 'new'});
    register(b.pi, s.tracker);
    await b.emit('session_start', {reason: 'new'});
    assert.equal(s.mood('new'), 'idle');

    const s2 = sandbox();
    const c = fakePi({sessionId: 'mid'});
    register(c.pi, s2.tracker);
    await c.emit('agent_start');   // no session_start seen
    assert.equal(s2.mood('mid'), 'thinking');
    s.done();
    s2.done();
});

await test('the factory never throws into Pi', async () => {
    familiar(null);
    familiar({on() { throw new Error('nope'); }});
    const dir = mkdtempSync(join(tmpdir(), 'familiar-pi-'));
    writeFileSync(join(dir, 'file'), '');
    const t = createTracker({dir: join(dir, 'file', 'sessions')});   // ENOTDIR
    t.start({cwd: '/p', sessionManager: {getSessionId: () => {throw new Error('x');}}});
    t.runStart();
    rmSync(dir, {recursive: true, force: true});
});

await test('rules can single out Pi', () => {
    const {config: c} = buildConfig({rules: [{event: 'Stop', agent: '^pi$', mood: 'idle'}]});
    assert.equal(resolveEvent(c, {event: 'Stop', agent: 'pi', ts: 1}, null).mood, 'idle');
    assert.equal(resolveEvent(c, {event: 'Stop', agent: 'opencode', ts: 1}, null).mood, 'done');
});

process.exit(failed ? 1 : 0);
