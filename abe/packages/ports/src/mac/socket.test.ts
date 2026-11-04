import { describe, expect, test } from 'bun:test';
import { existsSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tempState } from '@abe/testing';
import { holderOf, lockPathOf, takeLock, tryLock } from './lock';
import { ask, listen, SocketInUse } from './socket';

const echo = (line: string) => Promise.resolve({ line: `echo ${line}` });

describe('listen and ask', () => {
  test('one line in, one line out', async () => {
    const state = tempState();
    const listener = await listen(state.socket, echo);

    expect(await ask(state.socket, 'hi')).toEqual({ ok: true, line: 'echo hi' });
    await listener.close();
    expect(await ask(state.socket, 'hi')).toMatchObject({ ok: false, unreachable: true });
    state.remove();
  });

  test('the socket file of a killed serve is replaced', async () => {
    const state = tempState();
    const listening = `require('node:net').createServer().listen(${JSON.stringify(state.socket)})`;
    const crashed = Bun.spawn([process.execPath, '-e', listening]);

    while (!existsSync(state.socket)) await Bun.sleep(10);
    crashed.kill('SIGKILL');
    await crashed.exited;
    expect(existsSync(state.socket)).toBe(true);
    const listener = await listen(state.socket, echo);

    expect(await ask(state.socket, 'again')).toEqual({ ok: true, line: 'echo again' });
    await listener.close();
    state.remove();
  });

  test('a socket something answers on is SocketInUse', async () => {
    const state = tempState();
    const first = await listen(state.socket, echo);

    expect(listen(state.socket, echo)).rejects.toBeInstanceOf(SocketInUse);
    expect(await ask(state.socket, 'still')).toEqual({ ok: true, line: 'echo still' });
    await first.close();
    state.remove();
  });

  test('an answer its client gave up on says so (gone), one it waited for does not', async () => {
    const state = tempState();
    const said: string[] = [];
    const late = async (line: string) => {
      await Bun.sleep(line === 'slow' ? 200 : 0);

      return {
        line: `echo ${line}`,
        after: () => said.push(`after ${line}`),
        gone: () => said.push(`gone ${line}`),
      };
    };
    const listener = await listen(state.socket, late);
    const conn = createConnection(state.socket);

    conn.on('connect', () => conn.write('slow\n'));
    await Bun.sleep(50);
    conn.destroy();
    expect(await ask(state.socket, 'quick')).toEqual({ ok: true, line: 'echo quick' });
    await Bun.sleep(300);
    expect(said).toEqual(['after quick', 'gone slow', 'after slow']);
    await listener.close();
    state.remove();
  });

  // `abe serve stop` with a request in flight, and a new serve started meanwhile: the old one's
  // close removed the new one's socket once its last connection ended, and nothing answered.
  test('a listener closing late leaves the socket of the one listening after it', async () => {
    const state = tempState();
    const slow = async (line: string) => {
      await Bun.sleep(200);

      return { line: `old ${line}` };
    };
    const old = await listen(state.socket, slow);
    const inFlight = ask(state.socket, 'slow');

    await Bun.sleep(20);
    const closing = old.close();

    await Bun.sleep(20);
    const next = await listen(state.socket, echo);

    await closing;
    expect(await inFlight).toEqual({ ok: true, line: 'old slow' });
    expect(await ask(state.socket, 'new')).toEqual({ ok: true, line: 'echo new' });
    await next.close();
    expect(existsSync(state.socket)).toBe(false);
    state.remove();
  });

  test('a checked socket removed under it is bound again; one another answers on is lost', async () => {
    const state = tempState();
    const lost: string[] = [];
    const first = await listen(state.socket, echo, 0o600, {
      checkMs: 20,
      lost: () => lost.push('lost'),
      unlisted: () => lost.push('unlisted'),
    });

    unlinkSync(state.socket);
    await Bun.sleep(100);
    expect(await ask(state.socket, 'back')).toEqual({ ok: true, line: 'echo back' });
    unlinkSync(state.socket);
    const other = await listen(state.socket, (line) => Promise.resolve({ line: `other ${line}` }));

    await Bun.sleep(100);
    expect(lost).toEqual(['unlisted', 'lost']);
    await first.close();
    expect(await ask(state.socket, 'x')).toEqual({ ok: true, line: 'other x' });
    await other.close();
    state.remove();
  });

  test('asking where nothing listens is unreachable', async () => {
    const state = tempState();

    expect(await ask(state.socket, 'x')).toMatchObject({ ok: false, unreachable: true });
    state.remove();
  });
});

describe('the serve lock', () => {
  test('one holder at a time; the file names it, empty once let go', async () => {
    const state = tempState();
    const path = lockPathOf(state.socket);
    const held = await tryLock(path);

    expect(held).toBeDefined();
    expect(path.endsWith('/s.lock')).toBe(true);
    held?.listening();
    expect(holderOf(path)).toMatchObject({ pid: process.pid, listening: true });
    expect(await takeLock(state.socket)).toEqual({ ok: false, holder: process.pid });
    held?.release();
    expect(holderOf(path)).toBeUndefined();
    const again = await takeLock(state.socket);

    expect(again.ok).toBe(true);
    if (again.ok) again.held.release();
    state.remove();
  });

  // A serve alive and holding the lock, its socket gone: the next start ends it and takes over.
  test('a holder in another process: kept while it answers or starts, ended once listening on nothing', async () => {
    const state = tempState();
    const path = lockPathOf(state.socket);
    const holding = `
      const { tryLock } = await import(${JSON.stringify(`${import.meta.dir}/lock.ts`)});
      const held = await tryLock(${JSON.stringify(path)});
      if (process.argv.includes('listening')) held.listening();
      console.log('held');
      process.on('SIGTERM', () => undefined);
      setInterval(() => undefined, 1000);
    `;
    const start = (listening: boolean) =>
      Bun.spawn([process.execPath, '-e', holding, ...(listening ? ['listening'] : [])], {
        stdout: 'pipe',
      });
    const kills: string[] = [];
    const kill = (pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
      kills.push(signal);
      process.kill(pid, signal);
    };
    const quick = { deadMs: 100, graceMs: 100, everyMs: 20, kill };

    for (const listening of [false, true]) {
      const holder = start(listening);

      await holder.stdout.getReader().read();
      if (!listening) {
        // starting: it runs, and the start asking is told who holds it
        expect(await takeLock(state.socket, quick)).toEqual({ ok: false, holder: holder.pid });
        holder.kill('SIGKILL');
        await holder.exited;
        continue;
      }
      const answering = await listen(state.socket, echo);

      expect(await takeLock(state.socket, quick)).toEqual({ ok: false, holder: holder.pid });
      await answering.close();
      // listening on nothing: SIGTERM (ignored), then SIGKILL, and the lock is taken
      const took = await takeLock(state.socket, quick);

      expect(took.ok).toBe(true);
      expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
      if (took.ok) took.held.release();
      await holder.exited;
    }
    state.remove();
  }, 15_000);
});
