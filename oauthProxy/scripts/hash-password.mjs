#!/usr/bin/env node
import { hashPassword } from '../dist/password.js';

// Entrada interactiva sin eco: la contraseña no aparece en argumentos ni historial.
if (!process.stdin.isTTY) {
  console.error('Ejecutá este comando en una terminal interactiva.');
  process.exit(1);
}
process.stderr.write('Contraseña del proxy (mínimo 12 caracteres): ');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
let password = '';
const value = await new Promise((resolve) => {
  function input(chunk) {
    for (const char of chunk) {
      if (char === '\u0003') { process.stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
      if (char === '\r' || char === '\n') {
        process.stdin.off('data', input);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write('\n');
        resolve(password);
        return;
      }
      if (char === '\u007f' || char === '\b') password = Array.from(password).slice(0, -1).join('');
      else if (char >= ' ') password += char;
    }
  }
  process.stdin.on('data', input);
});
try { console.log(await hashPassword(value)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
