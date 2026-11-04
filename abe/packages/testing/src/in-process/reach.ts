/** `Aws` and `Secrets` for scenarios that never reach AWS. Every call refuses and names itself. */
import { type Answered, type Aws, type Secrets } from '@abe/core';

const refuse = (name: string) => () =>
  Promise.resolve<Answered<never>>({
    ok: false,
    error: { code: 'aws-failed', message: `${name}: this scenario has no AWS` },
  });

export const refusingAws = (): Aws => ({ assumeRole: refuse('assumeRole') });
export const refusingSecrets = (): Secrets => ({ read: refuse('secrets.read') });
