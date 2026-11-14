// opencode plugin for Familiar: records each opencode session's latest event in
// ~/.cache/familiar/sessions/opencode-<session>.json, in the same shape the Claude
// Code hook writes, so the GNOME extension's rules apply unchanged.
//
// One file serves both plugin APIs:
//   opencode 2.x    loads `setup(ctx)`  (Plugin.define shape: {id, setup})
//   opencode 1.x    loads `server(input)` (object entrypoint, 1.18.29 and newer)
// It never throws into opencode and never changes a tool call or a reply.

import {mkdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';

const AGENT = 'opencode';
const LOADED = Symbol.for('familiar.opencode.loaded');

function stateDir() {
    const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
    return join(cache, 'familiar', 'sessions');
}

function short(value, n) {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Mirrors hooks/pet-state.jq: the most useful single line about a tool call.
function toolDetail(tool, input) {
    const i = input && typeof input === 'object' ? input : {};
    const path = i.filePath ?? i.file_path ?? i.path ?? i.notebook_path;
    if (/^(bash|shell)$/i.test(tool ?? "") && i.command)
        return short(i.command, 80);
    if (path)
        return basename(String(path));
    if (i.pattern)
        return short(i.pattern, 40);
    if (i.url)
        return short(i.url, 60);
    if (i.description)
        return short(i.description, 60);
    return '';
}

function projectOf(cwd) {
    return String(cwd ?? '').split('/').filter(Boolean).pop() || AGENT;
}

// Session bookkeeping shared by both API versions. `now` is injectable for tests.
function createRecorder({dir = stateDir(), now = () => Math.floor(Date.now() / 1000)} = {}) {
    const sessions = new Map();   // id -> {cwd, tool, detail, failed}
    const children = new Set();   // subagent sessions: folded into their parent's pet
    const written = new Set();

    const fileFor = id => join(dir, `${AGENT}-${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.json`);
    const info = id => {
        if (!sessions.has(id))
            sessions.set(id, {cwd: '', tool: '', detail: '', failed: false});
        return sessions.get(id);
    };

    function write(id, event, extra = {}) {
        if (!id || children.has(id))
            return;
        try {
            const s = info(id);
            if (extra.cwd)
                s.cwd = extra.cwd;
            const record = {
                session_id: String(id),
                agent: AGENT,
                event,
                tool: extra.tool ?? '',
                type: extra.type ?? '',
                message: short(extra.message, 120),
                detail: extra.detail ?? '',
                cwd: s.cwd,
                project: projectOf(s.cwd),
                ts: now(),
            };
            mkdirSync(dir, {recursive: true});
            const file = fileFor(id);
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(record));
            renameSync(tmp, file);
            written.add(id);
        } catch {
            // The pet is decoration: never let it break opencode.
        }
    }

    function remove(id) {
        sessions.delete(id);
        written.delete(id);
        try {
            rmSync(fileFor(id), {force: true});
        } catch {}
    }

    return {
        cwd(id, cwd) {
            if (id && cwd)
                info(id).cwd = cwd;
        },
        created(id, {cwd, parentID} = {}) {
            if (parentID) {
                children.add(id);
                return;
            }
            this.cwd(id, cwd);
            write(id, 'SessionStart');
        },
        prompt(id, cwd) {
            this.cwd(id, cwd);
            info(id).failed = false;
            write(id, 'UserPromptSubmit');
        },
        toolStart(id, tool, input) {
            const s = info(id);
            s.tool = tool ?? '';
            s.detail = toolDetail(tool, input);
            write(id, 'PreToolUse', {tool: s.tool, detail: s.detail});
        },
        toolEnd(id, tool, ok, message) {
            const s = info(id);
            write(id, ok ? 'PostToolUse' : 'PostToolUseFailure',
                {tool: tool ?? s.tool, detail: s.detail, message});
        },
        permission(id, tool, detail, message) {
            write(id, 'PermissionRequest', {tool, detail: short(detail, 80), message});
        },
        // After an answer the tool runs (or the model carries on): back to working.
        answered(id, rejected) {
            const s = info(id);
            if (rejected || !s.tool)
                write(id, 'PostToolUse', {tool: s.tool});
            else
                write(id, 'PreToolUse', {tool: s.tool, detail: s.detail});
        },
        question(id, message) {
            write(id, 'Notification', {type: 'question', message: message || 'Has a question for you'});
        },
        finished(id) {
            if (!info(id).failed)
                write(id, 'Stop');
        },
        failed(id, message) {
            info(id).failed = true;
            write(id, 'StopFailure', {message});
        },
        ended(id) {
            remove(id);
        },
        // Plugin unload / process exit: forget every session this process reported.
        close() {
            for (const id of [...written])
                remove(id);
        },
    };
}

const errorText = e => (e && (e.message ?? e.data?.message ?? e.name)) || '';

// ---------- opencode 2.x ----------

async function setupV2(ctx, recorder = createRecorder()) {
    const home = ctx.location?.directory ?? '';
    const abort = new AbortController();
    const registrations = [];
    const cwdOf = ev => ev.location?.directory ?? ev.data?.location?.directory ?? home;

    registrations.push(await ctx.tool.hook('execute.before', ev => {
        recorder.cwd(ev.sessionID, home);
        recorder.toolStart(ev.sessionID, ev.tool, ev.input);
    }));
    registrations.push(await ctx.tool.hook('execute.after', ev => {
        recorder.toolEnd(ev.sessionID, ev.tool, ev.status !== 'error', ev.status === 'error' ? errorText(ev.error) : '');
    }));

    const types = [
        'session.created', 'session.deleted', 'session.archived',
        'session.execution.started', 'session.execution.succeeded',
        'session.execution.failed', 'session.execution.interrupted',
        'permission.asked', 'permission.replied', 'form.created', 'form.replied',
    ];
    (async () => {
        for await (const ev of ctx.event.subscribe({types, signal: abort.signal})) {
            try {
                handleV2(recorder, ev, cwdOf(ev));
            } catch {}
        }
    })().catch(() => {});

    return async () => {
        abort.abort();
        for (const r of registrations) {
            try {
                await (r?.dispose ?? r?.[Symbol.asyncDispose] ?? r?.[Symbol.dispose])?.call(r);
            } catch {}
        }
        recorder.close();
    };
}

function handleV2(recorder, ev, cwd) {
    const d = ev.data ?? {};
    const id = d.sessionID;
    switch (ev.type) {
    case 'session.created':
        return recorder.created(id, {cwd: d.location?.directory ?? cwd, parentID: d.parentID});
    case 'session.deleted':
    case 'session.archived':
        return recorder.ended(id);
    case 'session.execution.started':
        return recorder.prompt(id, cwd);
    case 'session.execution.succeeded':
        return recorder.finished(id);
    case 'session.execution.failed':
        return recorder.failed(id, errorText(d.error));
    case 'session.execution.interrupted':
        return d.reason === 'shutdown' ? recorder.ended(id) : recorder.finished(id);
    case 'permission.asked':
        return recorder.permission(id, d.action, (d.resources ?? []).join(' '), d.message);
    case 'permission.replied':
        return recorder.answered(id, /reject|deny/i.test(String(d.reply?.type ?? d.reply ?? '')));
    case 'form.created':
        return recorder.question(d.form?.sessionID, d.form?.title);
    case 'form.replied':
        return recorder.answered(d.sessionID, false);
    }
}

// ---------- opencode 1.x ----------

async function serverV1(input = {}, _options, recorder = createRecorder()) {
    const home = input.directory ?? '';
    const onExit = () => recorder.close();
    process.once('exit', onExit);
    return {
        'chat.message': async ev => {
            recorder.prompt(ev.sessionID, home);
        },
        'tool.execute.before': async (ev, out) => {
            recorder.cwd(ev.sessionID, home);
            recorder.toolStart(ev.sessionID, ev.tool, out?.args);
        },
        'tool.execute.after': async ev => {
            recorder.toolEnd(ev.sessionID, ev.tool, true);
        },
        event: async ({event}) => {
            try {
                handleV1(recorder, event, home);
            } catch {}
        },
        dispose: async () => {
            process.off('exit', onExit);
            recorder.close();
        },
    };
}

function handleV1(recorder, event, cwd) {
    const p = event?.properties ?? {};
    switch (event?.type) {
    case 'session.created':
        return recorder.created(p.info?.id, {cwd: p.info?.directory ?? cwd, parentID: p.info?.parentID});
    case 'session.deleted':
        return recorder.ended(p.info?.id);
    case 'session.idle':
        return recorder.finished(p.sessionID);
    case 'session.error':
        if (p.error?.name === 'MessageAbortedError')
            return recorder.finished(p.sessionID);
        return recorder.failed(p.sessionID, errorText(p.error));
    case 'message.part.updated': {
        const part = p.part ?? {};
        if (part.type === 'tool' && part.state?.status === 'error')
            recorder.toolEnd(part.sessionID, part.tool, false, part.state.error);
        return;
    }
    case 'permission.updated':   // older 1.x
    case 'permission.asked': {   // newer 1.x
        const pattern = Array.isArray(p.pattern) ? p.pattern.join(' ') : p.pattern ?? p.patterns?.join?.(' ');
        return recorder.permission(p.sessionID, p.type ?? p.permission, pattern ?? '', p.title);
    }
    case 'permission.replied':
        return recorder.answered(p.sessionID, /reject|deny/i.test(String(p.response ?? p.reply ?? '')));
    case 'question.asked':
        return recorder.question(p.sessionID, p.questions?.[0]?.question ?? p.question);
    case 'question.replied':
    case 'question.rejected':
        return recorder.answered(p.sessionID, false);
    }
}

// ---------- entrypoint ----------

// Guard against loading twice in one process (e.g. found in both plugin dirs).
// Released again on cleanup, so a plugin reload registers afresh.
async function exclusive(start, empty) {
    if (globalThis[LOADED])
        return empty;
    globalThis[LOADED] = true;
    try {
        return await start(() => { globalThis[LOADED] = false; });
    } catch {
        globalThis[LOADED] = false;
        return empty;
    }
}

const plugin = {
    id: 'familiar',
    setup: ctx => exclusive(async release => {
        const cleanup = await setupV2(ctx);
        return async () => {
            await cleanup();
            release();
        };
    }, undefined),
    server: (input, options) => exclusive(async release => {
        const hooks = await serverV1(input, options);
        const dispose = hooks.dispose;
        hooks.dispose = async () => {
            await dispose();
            release();
        };
        return hooks;
    }, {}),
};

// Internals for test/test-opencode.mjs, under a symbol so plugin loaders never see them.
Object.defineProperty(plugin, Symbol.for('familiar.internals'), {
    value: {toolDetail, createRecorder, handleV1, handleV2, setupV2, serverV1},
});

// The only export: older 1.x loaders call every exported function as a plugin.
export default plugin;
