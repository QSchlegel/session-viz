// Writing large output to stdout, without losing the end of it.
//
// `console.log(bigString); process.exit(0)` truncates. stdout to a pipe is
// asynchronous with a 64 KB buffer, and process.exit() does not wait for it to
// drain — so anything past the buffer is discarded, silently, with a zero exit
// code. It is invisible from a terminal, where stdout is a TTY and writes
// synchronously, and it only appears once the payload grows past 64 KB.
//
// This was live: `ship.mjs --json` wrote 139,540 bytes to a file and exactly
// 65,536 to a pipe. Any consumer reading it got JSON that ended mid-token.
//
// writeOut waits for the write to be handed to the OS before returning, so a
// process.exit() after an `await writeOut(...)` is safe.

export function writeOut(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text.endsWith('\n') ? text : text + '\n', (err) =>
      // EPIPE is normal — `| head` closes the pipe early and that is the
      // caller's business, not a failure of ours.
      err && (err as NodeJS.ErrnoException).code !== 'EPIPE' ? reject(err) : resolve(),
    )
  })
}

/** The common case: emit a JSON document and stop, with nothing lost. */
export async function emitJson(value: unknown): Promise<void> {
  await writeOut(JSON.stringify(value, null, 2))
}
