/**
 * A card's launch refused while an enabled environment's aws login is expired or missing: a
 * session can't run `abe login`, so a run started so stops at Needs you in its first step. Each
 * environment on for agents (prod too when `--prod` turns it on for the run) whose aws profile
 * your Layer names is read once per profile, all at once, each within `timeoutMs`; one with no
 * profile is skipped, and one with no answer in time is not refused (nothing was learnt). A box's
 * launch is read on the Mac too: its keys are synced from here.
 */
import {
  type AbeEnv,
  type Credentials,
  type Outcome,
  loginFix,
  refused,
  syncedEnvs,
  withOwnReach,
} from '@abe/core';

/** Whether a profile gives keys now (`InstallRepo.awsCredentials`); why not, an expired login. */
export type AwsLoginCheck = (profile: string) => Promise<{ ok: true } | { ok: false; why: string }>;

/** How long one profile's read may take before the launch goes on without its answer. */
export const AWS_LOGIN_TIMEOUT_MS = 8_000;

/** The environments a launch's session reaches: those `on` for agents, prod when `prodOn`. */
export const launchEnvs = (
  on: (env: AbeEnv) => boolean | undefined,
  prodOn: boolean,
): readonly AbeEnv[] => withOwnReach(syncedEnvs(on), prodOn);

/** `aws-login-expired`, naming each environment and its sign-in; null: every login reads. */
export const awsLoginsRefused = async (o: {
  check: AwsLoginCheck | undefined;
  credentials: Credentials | undefined;
  envs: readonly AbeEnv[];
  timeoutMs?: number;
}): Promise<Outcome<null>> => {
  const { check } = o;

  if (check === undefined) return { ok: true, data: null };
  const byProfile = new Map<string, AbeEnv[]>();

  for (const env of o.envs) {
    const profile = o.credentials?.[env]?.awsProfile;

    if (profile !== undefined && profile !== null)
      byProfile.set(profile, [...(byProfile.get(profile) ?? []), env]);
  }
  const timeoutMs = o.timeoutMs ?? AWS_LOGIN_TIMEOUT_MS;
  const read = await Promise.all(
    [...byProfile].map(async ([profile, envs]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((done) => {
        timer = setTimeout(() => {
          done('late');
        }, timeoutMs);
      });
      const said = await Promise.race([check(profile).catch(() => 'late' as const), late]);

      clearTimeout(timer);

      return { profile, envs, ok: said === 'late' || said.ok };
    }),
  );
  const failed = read.filter((r) => !r.ok);

  if (failed.length === 0) return { ok: true, data: null };

  return refused(
    'aws-login-expired',
    `the aws login of ${failed.map((f) => `${f.envs.join(' and ')} (${f.profile})`).join(', ')} is expired or missing, and a run can't sign in: sign in yourself in Terminal, then launch again: ${failed.map((f) => loginFix('aws', null, f.profile)).join('; ')}`,
  );
};
