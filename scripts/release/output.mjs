export function redact(value) {
  let text = String(value);
  for (const token of [process.env.GITHUB_TOKEN, process.env.GH_TOKEN].filter(Boolean)) text = text.split(token).join('[REDACTED]');
  return text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/g, '$1[REDACTED]@');
}
export function protectOutput() {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...args) => write(redact(chunk), ...args);
  }
}
