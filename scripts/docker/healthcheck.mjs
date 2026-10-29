try {
  const response = await fetch('http://127.0.0.1:3000/api/projects', { signal: AbortSignal.timeout(4000) });
  if (!response.ok || !Array.isArray(await response.json())) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
