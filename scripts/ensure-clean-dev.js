'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const selfPid = process.pid;

function getParentPids(pid) {
  const parents = new Set([pid]);
  let current = pid;
  while (current && current > 1) {
    try {
      const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(current)], { encoding: 'utf8' }).trim();
      const ppid = Number.parseInt(out, 10);
      if (!Number.isFinite(ppid) || ppid <= 1 || parents.has(ppid)) break;
      parents.add(ppid);
      current = ppid;
    } catch {
      break;
    }
  }
  return parents;
}

function listRepoProcesses() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        command: match[3],
      };
    })
    .filter(Boolean)
    .filter((proc) => proc.command.includes(repoRoot))
    .filter((proc) => /electron-vite|\/Electron(?:\s|$)|agent-ui/.test(proc.command));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killMany(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error && error.code !== 'ESRCH') throw error;
    }
  }
}

const protectedPids = getParentPids(selfPid);
const targets = listRepoProcesses()
  .filter((proc) => !protectedPids.has(proc.pid))
  .sort((a, b) => b.pid - a.pid);

if (!targets.length) {
  console.log('[agent-ui] no prior dev/preview processes found');
  process.exit(0);
}

console.log('[agent-ui] stopping prior dev/preview processes:');
for (const proc of targets) {
  console.log(`- pid ${proc.pid}: ${proc.command}`);
}

const targetPids = targets.map((proc) => proc.pid);
killMany(targetPids, 'SIGTERM');
sleep(1200);

const survivors = targetPids.filter(isAlive);
if (survivors.length) {
  console.log(`[agent-ui] force stopping stubborn processes: ${survivors.join(', ')}`);
  killMany(survivors, 'SIGKILL');
  sleep(300);
}

const remaining = targetPids.filter(isAlive);
if (remaining.length) {
  console.error(`[agent-ui] failed to stop: ${remaining.join(', ')}`);
  process.exit(1);
}

console.log('[agent-ui] prior dev/preview processes cleared');
