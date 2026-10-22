// Runs the API server and the web frontend together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tasks = [
  { name: 'server', color: 36, args: ['run', 'dev', '-w', 'server'] },
  { name: 'web', color: 35, args: ['run', 'dev', '-w', 'web'] },
];

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  process.exitCode = code;
}

for (const task of tasks) {
  const prefix = `\x1b[${task.color}m[${task.name}]\x1b[0m `;
  const child = spawn(npm, task.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);

  for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        // npm reports the SIGTERM we sent on Ctrl+C as a failure; hide that noise.
        if (shuttingDown && line.startsWith('npm error')) continue;
        out.write(prefix + line + '\n');
      }
    });
    stream.on('end', () => {
      if (buffered) out.write(prefix + buffered + '\n');
    });
  }

  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`${prefix}exited (${signal ?? code}); stopping the other process`);
      shutdown(code ?? 1);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
