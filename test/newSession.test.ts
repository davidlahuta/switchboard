import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Bus } from '../src/daemon/bus.ts';
import { Coordinator } from '../src/daemon/coord.ts';
import { Db } from '../src/daemon/db.ts';
import { newSessionToolRequest, runNewSessionTool } from '../src/daemon/newSessionTool.ts';
import { DEFAULT_SETTINGS } from '../src/daemon/settings.ts';
import {
  NEW_SESSION_FIELDS,
  NEW_SESSION_TOOL_PROPERTIES,
  newSessionDefaults,
  newSessionRequest,
  type NewSessionForm,
} from '../src/shared/newSession.ts';
import { TOOLS } from '../src/shared/tools.ts';
import type { Settings } from '../src/shared/types.ts';

/*
 * The web UI's New session dialog and an agent's sb_new_session must start the same session for the
 * same choices. Both build their request in src/shared/newSession.ts; these tests hold each side to
 * using it completely: every dialog field is a tool parameter, both start from the same defaults, and
 * any single choice made on either side gives the same request.
 */

const HERE = path.resolve(os.tmpdir(), 'sb-repo', '.claude', 'worktrees', 'lane');
const caller = { worktree: HERE, cwd: path.join(HERE, 'src') };
const subscriptions = [
  { id: 'max-1', label: 'Max 20x', ready: true },
  { id: 'pro-2', label: 'Pro', ready: false },
];
const deps = (settings: Settings = DEFAULT_SETTINGS) => ({ settings: () => settings, subscriptions: () => subscriptions });

/** What the dialog sends when the person changes one field and nothing else, opened on HERE. */
const dialog = (settings: Settings, change: Partial<NewSessionForm> = {}) => newSessionRequest({ ...newSessionDefaults(settings, HERE), ...change });

/** A value for each field that differs from its default, as the dialog would hold it and as an agent would pass it. */
const CHANGES: Record<(typeof NEW_SESSION_FIELDS)[number], { form: Partial<NewSessionForm>; tool: Record<string, unknown> }> = {
  cwd: { form: { cwd: path.join(HERE, 'docs') }, tool: { cwd: path.join(HERE, 'docs') } },
  subscriptionId: { form: { subscriptionId: 'max-1' }, tool: { subscriptionId: 'max-1' } },
  name: { form: { name: 'auth refactor' }, tool: { name: 'auth refactor' } },
  worktree: { form: { worktree: 'auth' }, tool: { worktree: 'auth' } },
  resumeSessionId: { form: { resumeSessionId: '8f322f77-5b11-4993-b179-a3aa782949e6' }, tool: { resumeSessionId: '8f322f77-5b11-4993-b179-a3aa782949e6' } },
  model: { form: { model: 'claude-opus-5' }, tool: { model: 'claude-opus-5' } },
  autoCompact: { form: { autoCompact: !DEFAULT_SETTINGS.defaultAutoCompact }, tool: { autoCompact: !DEFAULT_SETTINGS.defaultAutoCompact } },
  autoCompactTokens: { form: { autoCompactTokens: 300_000 }, tool: { autoCompactTokens: 300_000 } },
  skipPermissions: { form: { skipPermissions: !DEFAULT_SETTINGS.defaultSkipPermissions }, tool: { skipPermissions: !DEFAULT_SETTINGS.defaultSkipPermissions } },
  diffPanel: { form: { diffPanel: !DEFAULT_SETTINGS.defaultDiffPanel }, tool: { diffPanel: !DEFAULT_SETTINGS.defaultDiffPanel } },
  autoSwap: { form: { autoSwap: !DEFAULT_SETTINGS.autoSwap }, tool: { autoSwap: !DEFAULT_SETTINGS.autoSwap } },
  continueOnResume: { form: { continueOnResume: !DEFAULT_SETTINGS.continueOnResume }, tool: { continueOnResume: !DEFAULT_SETTINGS.continueOnResume } },
  args: { form: { args: ['--verbose'] }, tool: { args: ['--verbose'] } },
};

describe('the New session dialog and sb_new_session', () => {
  it('offer the same options: every dialog field is a tool parameter, under the same name', () => {
    const tool = TOOLS.find((t) => t.name === 'sb_new_session');
    assert.ok(tool, 'the tool is advertised');
    assert.deepEqual(tool.inputSchema.properties, NEW_SESSION_TOOL_PROPERTIES);
    assert.deepEqual(Object.keys(NEW_SESSION_TOOL_PROPERTIES).sort(), [...NEW_SESSION_FIELDS, 'task'].sort(), 'the fields, plus only task');
    assert.deepEqual(Object.keys(newSessionDefaults(DEFAULT_SETTINGS, HERE)).sort(), [...NEW_SESSION_FIELDS].sort(), 'the form has exactly these fields');
    assert.equal(tool.inputSchema.required, undefined, 'and every one of them is optional, as in the dialog');
  });

  it('start from the same defaults: a tool call with nothing in it is the dialog submitted untouched', () => {
    assert.deepEqual(newSessionToolRequest({}, caller, deps()), dialog(DEFAULT_SETTINGS));
  });

  it('follow the defaults in Settings together', () => {
    const changed: Settings = {
      ...DEFAULT_SETTINGS,
      defaultAutoCompact: !DEFAULT_SETTINGS.defaultAutoCompact,
      defaultAutoCompactTokens: 400_000,
      defaultSkipPermissions: !DEFAULT_SETTINGS.defaultSkipPermissions,
      defaultDiffPanel: !DEFAULT_SETTINGS.defaultDiffPanel,
      autoSwap: !DEFAULT_SETTINGS.autoSwap,
      continueOnResume: !DEFAULT_SETTINGS.continueOnResume,
    };
    const request = newSessionToolRequest({}, caller, deps(changed));
    assert.deepEqual(request, dialog(changed));
    assert.notDeepEqual(request, dialog(DEFAULT_SETTINGS), 'and the settings really do reach the request');
  });

  for (const field of NEW_SESSION_FIELDS) {
    it(`give the same session for a change to ${field}, and that change reaches the request`, () => {
      const { form, tool } = CHANGES[field];
      const fromDialog = dialog(DEFAULT_SETTINGS, form);
      assert.deepEqual(newSessionToolRequest(tool, caller, deps()), fromDialog);
      assert.notDeepEqual(fromDialog, dialog(DEFAULT_SETTINGS), `${field} is not a dead control`);
    });
  }

  it('treat a resumed session the same way: it gets no new worktree on either side', () => {
    const both = { worktree: 'auth', resumeSessionId: '8f322f77-5b11-4993-b179-a3aa782949e6' };
    const request = newSessionToolRequest(both, caller, deps());
    assert.deepEqual(request, dialog(DEFAULT_SETTINGS, both));
    assert.equal(request.worktree, undefined);
  });

  it('clamp the compaction point the same way', () => {
    assert.deepEqual(newSessionToolRequest({ autoCompactTokens: 5 }, caller, deps()), dialog(DEFAULT_SETTINGS, { autoCompactTokens: 5 }));
    assert.equal(newSessionToolRequest({ autoCompactTokens: 5 }, caller, deps()).autoCompactTokens, 20_000);
  });

  it('build the dialog request with the shared builder, from every field, and its defaults from the shared defaults', () => {
    const source = fs.readFileSync(path.resolve('web/src/components/NewSessionDialog.tsx'), 'utf8');
    assert.match(source, /from '@shared\/newSession\.ts'/);
    assert.match(source, /newSessionDefaults\(state\.settings/);
    const call = /newSessionRequest\(\{([\s\S]*?)\}\)/.exec(source);
    assert.ok(call, 'the dialog builds its request with newSessionRequest');
    const keys = call[1]
      .split(',')
      .map((part) => part.trim().split(':')[0].trim())
      .filter(Boolean);
    assert.deepEqual([...keys].sort(), [...NEW_SESSION_FIELDS].sort(), 'from every field of the form');
    assert.doesNotMatch(source, /state\.settings\.(defaultAutoCompact|defaultAutoCompactTokens|defaultSkipPermissions|defaultDiffPanel|autoSwap|continueOnResume)\b/, 'no default is read around the shared ones');
  });
});

describe('what only an agent needs', () => {
  it('starts in the worktree the agent is in, and reads a relative folder from where it is', () => {
    assert.equal(newSessionToolRequest({}, caller, deps()).cwd, HERE);
    assert.equal(newSessionToolRequest({ cwd: '../tests' }, caller, deps()).cwd, path.join(HERE, 'tests'));
  });

  it('finds a subscription by the label it sees, and lists the choices when one is wrong', async () => {
    assert.equal(newSessionToolRequest({ subscriptionId: 'max 20X' }, caller, deps()).subscriptionId, 'max-1');
    await assert.rejects(
      runNewSessionTool({ subscriptionId: 'nope' }, caller, {
        ...deps(),
        create: async () => {
          throw new Error('Unknown subscription nope');
        },
      }),
      /Logged-in subscriptions: Max 20x \(max-1\), or 'auto'/,
    );
  });

  it('hands a started session its task as a request from the agent that started it, once it joins', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-new-'));
    const db = new Db(':memory:');
    const coord = new Coordinator(db, new Bus());
    coord.setPushTarget({ push: () => false, isConnected: () => false, rekey: () => false });
    let seen: { args: Record<string, unknown>; worktree: string | null } | null = null;
    coord.setSessionStarter(async (who, args) => {
      seen = { args, worktree: who.worktree };
      return { runId: 'run-new', text: 'Started "helper".' };
    });
    const repoId = (await coord.registerAgent({ sessionId: 'boss1111', cwd: dir, name: 'boss' })).repo_id;

    const r = await coord.runTool('boss1111', 'sb_new_session', { name: 'helper', task: 'write the migration test' });
    assert.equal(r.isError, false);
    assert.equal(r.text, 'Started "helper".');
    assert.deepEqual(seen!.args, { name: 'helper', task: 'write the migration test' });

    await coord.registerAgent({ sessionId: 'help2222', cwd: dir, name: 'helper', runId: 'run-new' });
    const handed = coord.raw.get<{ from_id: string; to_id: string; kind: string; body: string }>('SELECT from_id, to_id, kind, body FROM messages WHERE to_id = ?', 'help2222');
    assert.deepEqual({ ...handed }, { from_id: 'boss1111', to_id: 'help2222', kind: 'request', body: 'write the migration test' });
    assert.ok(coord.repoDetail(repoId));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

