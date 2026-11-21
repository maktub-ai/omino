import { randomUUID } from 'node:crypto';
import { runHook } from './omino.mjs';

export const name = 'omino';

function context(text) {
  return { id: randomUUID(), role: 'user', source: { kind: 'omino' }, content: [{ type: 'text', text }] };
}

export function apply(ctx) {
  const sessions = new WeakSet();

  function hook(event, agent, fields) {
    const result = runHook(event, { cwd: agent.session.header.cwd, session_id: agent.session.header.id, ...fields }, { agent: 'dsh' });
    if (result.stderr) ctx.logger?.warn(result.stderr);
    return result.stdout;
  }

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || !agent.session.header.cwd || agent.session.header.parentSession) return decision;
    const human = messages.filter((message) => message.source.kind === 'user');
    if (!human.length) return decision;

    const notes = [];
    if (!sessions.has(agent)) {
      sessions.add(agent);
      notes.push(hook('session-start', agent));
    }
    const prompt = human.flatMap((message) => message.content).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    notes.push(hook('prompt', agent, { prompt }));
    const text = notes.filter(Boolean).join('\n\n');
    return text ? { ...decision, messages: [context(text), ...decision.messages] } : decision;
  });

  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!sessions.has(agent)) return;
    const reminder = hook('stop', agent);
    if (reminder) agent.steer(context(JSON.parse(reminder).reason));
  });

  ctx.on('agent/disposed', ({ agent }) => {
    if (sessions.delete(agent)) hook('session-end', agent);
  });
}
