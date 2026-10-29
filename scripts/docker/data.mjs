import { execFileSync } from 'node:child_process';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

const database = process.env.HAULPATH_DB_PATH || '/app/data/haulpath.sqlite';

function sqlite(arguments_) {
  return execFileSync('sqlite3', ['-batch', '-bail', '-init', '/dev/null', ...arguments_], {
    encoding: 'utf8', maxBuffer: 16_000_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function validateSnapshot(snapshot) {
  const input = await open(snapshot, 'r');
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await input.read(header, 0, header.length, 0);
    if (bytesRead !== 16 || header.toString() !== 'SQLite format 3\0') {
      throw new Error('输入不是完整的 SQLite 备份');
    }
  } finally { await input.close(); }
  const uri = pathToFileURL(snapshot);
  uri.searchParams.set('immutable', '1');
  if (sqlite(['-readonly', uri.href, 'PRAGMA integrity_check;']).trim() !== 'ok') {
    throw new Error('SQLite 备份完整性检查失败');
  }
}

async function backup(source) {
  if (!(await stat(source)).isFile()) throw new Error('源数据库不是普通文件');
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-backup-'));
  try {
    const snapshot = join(directory, 'snapshot.sqlite');
    sqlite(['-cmd', '.timeout 5000', '-readonly', source, `.backup '${snapshot}'`]);
    await validateSnapshot(snapshot);
    await pipeline(createReadStream(snapshot), process.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function installBackup({ replaceExisting = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-restore-'));
  let archive;
  let prepared;
  try {
    if (!replaceExisting) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { await lstat(`${database}${suffix}`); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        throw new Error('迁入目标已有数据库或 sidecar，拒绝覆盖');
      }
    }
    const snapshot = join(directory, 'snapshot.sqlite');
    await pipeline(process.stdin, createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }));
    await validateSnapshot(snapshot);
    prepared = join(dirname(database), `.restoring-${randomUUID()}.sqlite`);
    await copyFile(snapshot, prepared, constants.COPYFILE_EXCL);
    if (!replaceExisting) {
      await link(prepared, database);
      await unlink(prepared);
      console.error('迁入完成，原资料保持不变');
      return;
    }
    archive = join(dirname(database), `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    await mkdir(archive, { mode: 0o700 });
    for (const suffix of ['', '-wal', '-shm']) {
      const previous = `${database}${suffix}`;
      try { await lstat(previous); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await rename(previous, join(archive, `haulpath.sqlite${suffix}`));
    }
    await rename(prepared, database);
    console.error(`恢复完成，原资料归档为：${archive}`);
  } catch (error) {
    if (archive) console.error(`恢复未完成，保留归档：${archive}；准备文件：${prepared}`);
    else if (prepared) console.error(`安装未完成，请检查准备文件：${prepared}`);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function sourceSnapshot(source) {
  const details = source ? await stat(source) : undefined;
  if (!details?.isFile() || details.size < 16) {
    throw new Error('迁入源不是完整的 SQLite 文件');
  }
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-migrate-source-'));
  try {
    const frozen = join(directory, 'source.sqlite');
    for (const suffix of ['', '-wal', '-shm']) {
      try { await copyFile(`${source}${suffix}`, `${frozen}${suffix}`, constants.COPYFILE_EXCL); }
      catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error; }
    }
    await backup(frozen);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  if (process.argv[2] === 'backup') await backup(database);
  else if (process.argv[2] === 'restore') await installBackup({ replaceExisting: true });
  else if (process.argv[2] === 'migrate') await installBackup();
  else if (process.argv[2] === 'source') await sourceSnapshot(process.argv[3]);
  else throw new Error('不支持的容器维护操作');
} catch (error) {
  console.error(`数据维护失败：${error.message}`);
  process.exitCode = 1;
}
