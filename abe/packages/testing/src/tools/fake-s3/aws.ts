/**
 * A fake `aws` for S3 as a real process. It runs `s3api put-object`, `get-object` and
 * `list-objects-v2` over a folder, and prints and fails as the CLI does. Its folder is the folder
 * of the script that imports it. Objects live under `objects/`, each key URI-encoded so `a` and
 * `a/b` can both be there. `deny` lists key prefixes, one per line, where a put gets AccessDenied.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dir = dirname(process.argv[1] ?? '.');
const objects = join(dir, 'objects');
const argv = process.argv.slice(2);

const flag = (name: string) => {
  const i = argv.indexOf(name);

  return i === -1 ? undefined : argv[i + 1];
};

const fail = (code: string, operation: string, message: string): never => {
  process.stderr.write(
    `\nAn error occurred (${code}) when calling the ${operation} operation: ${message}\n`,
  );
  process.exit(254);
};

const bucket = flag('--bucket') ?? fail('MissingParameter', 'S3', 'no --bucket');
const at = (key: string) => join(objects, encodeURIComponent(`${bucket}/${key}`));
const denied = () =>
  existsSync(join(dir, 'deny'))
    ? readFileSync(join(dir, 'deny'), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
    : [];

mkdirSync(objects, { recursive: true });

if (argv[0] !== 's3api') fail('InvalidAction', argv[0] ?? 'aws', 'this fake aws only does s3api');

switch (argv[1]) {
  case 'put-object': {
    const key = flag('--key') ?? fail('MissingParameter', 'PutObject', 'no --key');
    const body = flag('--body') ?? fail('MissingParameter', 'PutObject', 'no --body');

    if (denied().some((p) => key.startsWith(p)))
      fail(
        'AccessDenied',
        'PutObject',
        `User: arn:aws:sts::111111111111:assumed-role/fake/box is not authorized to perform: s3:PutObject on resource: "arn:aws:s3:::${bucket}/${key}" with an explicit deny in a resource-based policy`,
      );
    copyFileSync(body, at(key));
    process.stdout.write(
      `${JSON.stringify({ ETag: '"fake"', ServerSideEncryption: 'aws:kms', BucketKeyEnabled: true }, null, 4)}\n`,
    );
    break;
  }
  case 'get-object': {
    const key = flag('--key') ?? fail('MissingParameter', 'GetObject', 'no --key');
    const out = argv.at(-1) ?? '';

    if (!existsSync(at(key))) fail('NoSuchKey', 'GetObject', 'The specified key does not exist.');
    copyFileSync(at(key), out);
    process.stdout.write(`${JSON.stringify({ ContentLength: statSync(at(key)).size }, null, 4)}\n`);
    break;
  }
  case 'list-objects-v2': {
    const prefix = flag('--prefix') ?? '';
    const contents = readdirSync(objects)
      .map((name) => decodeURIComponent(name))
      .filter((name) => name.startsWith(`${bucket}/${prefix}`))
      .map((name) => name.slice(bucket.length + 1))
      .sort()
      .map((key) => ({ Key: key, Size: statSync(at(key)).size, StorageClass: 'STANDARD' }));
    const page =
      contents.length === 0
        ? { RequestCharged: null, Prefix: prefix }
        : { Contents: contents, RequestCharged: null, Prefix: prefix };

    process.stdout.write(`${JSON.stringify(page, null, 4)}\n`);
    break;
  }
  default:
    fail('InvalidAction', `s3api ${argv[1] ?? ''}`, 'this fake aws does not do that');
}
