// Pi extension for Familiar: records the Pi session's latest event in
// ~/.cache/familiar/sessions/pi-<session>.json, in the same shape the Claude Code
// hook writes, so the GNOME extension's rules apply unchanged.
//
// Works with Pi 1.x (@earendil-works/pi-coding-agent) and 0.7x
// (@mariozechner/pi-coding-agent). It only observes: it never blocks a tool
// call or changes a message, and errors inside it are swallowed.

import {mkdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';

const AGENT = 'pi';
// Pi 0.7x has no agent_settled: treat agent_end as the end of the run once it
// has been quiet this long (a retry or follow-up starts a new run sooner).
const SETTLE_MS = 1500;

function stateDir() {
    const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
    return join(cache, 'familiar', 'sessions');
}

function short(value, n) {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Mirrors hooks/pet-state.jq: the most useful single line about a tool call.
function toolDetail(tool, args) {
    const i = args && typeof args === 'object' ? args : {};
    const path = i.path ?? i.file_path ?? i.filePath;
    if (/^bash$/i.test(tool ?? '') && i.command)
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

function resultText(result) {
    const part = Array.isArray(result?.content) ? result.content.find(c => c?.type === 'text') : null;
    return part?.text ?? (typeof result === 'string' ? result : '');
}

// The error a run ended with, if its last assistant message failed.
function runError(messages) {
    const last = [...(messages ?? [])].reverse().find(m => m?.role === 'assistant');
    if (last?.stopReason === 'error')
        return last.errorMessage || 'The model request failed';
    return null;
}

// All state for one Pi process. `now` and `setTimer` are injectable for tests.
function createTracker({dir = stateDir(), now = () => Math.floor(Date.now() / 1000),
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = t => clearTimeout(t)} = {}) {
    let session = null;      // {id, cwd}
    let last = null;         // last record written, restored after a UI prompt
    let prompting = false;
    let pendingError = null; // error from agent_end, reported once Pi settles
    let sawSettled = false;  // Pi 1.x: agent_settled is the real end of a run
    let timer = null;

    const fileFor = id => join(dir, `${AGENT}-${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.json`);

    function write(event, extra = {}, {remember = true} = {}) {
        if (!session)
            return;
        try {
            const record = {
                session_id: session.id,
                agent: AGENT,
                event,
                tool: extra.tool ?? '',
                type: extra.type ?? '',
                message: short(extra.message, 120),
                detail: extra.detail ?? '',
                cwd: session.cwd,
                project: String(session.cwd).split('/').filter(Boolean).pop() || AGENT,
                ts: now(),
            };
            if (remember)
                last = {event, extra};
            mkdirSync(dir, {recursive: true});
            const file = fileFor(session.id);
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(record));
            renameSync(tmp, file);
        } catch {
            // The pet is decoration: never let it break Pi.
        }
    }

    function cancelSettle() {
        if (timer !== null)
            clearTimer(timer);
        timer = null;
    }

    function finish(aborted) {
        cancelSettle();
        const error = pendingError;
        pendingError = null;
        if (error && !aborted)
            write('StopFailure', {message: error});
        else
            write('Stop');
    }

    function end() {
        cancelSettle();
        if (session) {
            try {
                rmSync(fileFor(session.id), {force: true});
            } catch {}
        }
        session = null;
        last = null;
        prompting = false;
        pendingError = null;
    }

    return {
        start(ctx) {
            let id = '';
            try {
                id = ctx?.sessionManager?.getSessionId?.() ?? '';
            } catch {}
            if (session && session.id !== (id || session.id))
                end();
            session = {id: String(id || `pid${process.pid}`), cwd: ctx?.cwd ?? process.cwd()};
            write('SessionStart');
        },
        ensure(ctx) {
            if (!session)
                this.start(ctx);
        },
        runStart() {
            cancelSettle();
            pendingError = null;
            write('UserPromptSubmit');
        },
        toolStart(name, args) {
            write('PreToolUse', {tool: name ?? '', detail: toolDetail(name, args)});
        },
        toolEnd(name, args, isError, result) {
            const detail = toolDetail(name, args);
            if (isError)
                write('PostToolUseFailure', {tool: name ?? '', detail, message: resultText(result)});
            else
                write('PostToolUse', {tool: name ?? '', detail});
        },
        promptStart(kind, title) {
            prompting = true;
            write('Notification', {type: `ui_${kind || 'prompt'}`, message: title || 'Waiting for your answer'}, {remember: false});
        },
        promptEnd() {
            if (!prompting)
                return;
            prompting = false;
            if (last)
                write(last.event, last.extra);
        },
        runEnd(messages) {
            pendingError = runError(messages) ?? pendingError;
            if (sawSettled)
                return;
            cancelSettle();
            timer = setTimer(() => {
                timer = null;
                finish(false);
            }, SETTLE_MS);
            timer?.unref?.();
        },
        settled(aborted) {
            sawSettled = true;
            finish(Boolean(aborted));
        },
        end,
    };
}

function register(pi, tracker = createTracker()) {
    // Every handler makes sure a session is known: an extension loaded by
    // /reload mid-session may never see session_start.
    const on = (event, handler) => {
        try {
            pi.on(event, async (ev, ctx) => {
                try {
                    if (event !== 'session_start')
                        tracker.ensure(ctx);
                    handler(ev ?? {}, ctx);
                } catch {}
            });
        } catch {
            // An older Pi that doesn't know this event: skip it.
        }
    };

    on('session_start', (_ev, ctx) => tracker.start(ctx));
    on('agent_start', () => tracker.runStart());
    on('tool_execution_start', ev => tracker.toolStart(ev.toolName, ev.args));
    on('tool_execution_end', ev => tracker.toolEnd(ev.toolName, ev.args, ev.isError, ev.result));
    on('ui_prompt_start', ev => tracker.promptStart(ev.kind, ev.title));
    on('ui_prompt_end', () => tracker.promptEnd());
    on('agent_end', ev => tracker.runEnd(ev.messages));
    on('agent_settled', ev => tracker.settled(ev.aborted));
    const onExit = () => tracker.end();
    process.once('exit', onExit);
    try {
        pi.on('session_shutdown', async () => {
            tracker.end();
            process.off('exit', onExit);   // a replacement runtime registers its own
        });
    } catch {}
    return tracker;
}

export default function familiar(pi) {
    try {
        register(pi);
    } catch {}
}

// Internals for test/test-pi.mjs, under a symbol so Pi never sees them.
Object.defineProperty(familiar, Symbol.for('familiar.internals'), {
    value: {toolDetail, runError, createTracker, register, SETTLE_MS},
});
