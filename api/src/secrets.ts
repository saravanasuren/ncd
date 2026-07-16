/**
 * AWS SSM Parameter Store loader (docs/10 §1). In production, secrets live
 * under /dhanam/newwealth/* and are pulled into process.env at boot BEFORE
 * config.ts validates. No-op locally (SSM_PARAMETERS_PATH unset), so dev keeps
 * using .env. Never writes secrets to disk.
 */
export async function loadSecretsFromSsm(): Promise<void> {
  const path = process.env.SSM_PARAMETERS_PATH;
  if (!path) return; // local dev — .env is authoritative

  const region = process.env.SSM_REGION || 'ap-south-1';
  // Lazy import so local dev doesn't need the AWS SDK loaded.
  const { SSMClient, GetParametersByPathCommand } = await import('@aws-sdk/client-ssm');
  const client = new SSMClient({ region });

  let nextToken: string | undefined;
  let count = 0;
  do {
    const res = await client.send(new GetParametersByPathCommand({
      Path: path,
      WithDecryption: true,
      Recursive: true,
      NextToken: nextToken,
    }));
    for (const p of res.Parameters ?? []) {
      if (!p.Name || p.Value == null) continue;
      const key = p.Name.slice(path.length).replace(/^\//, ''); // strip the prefix
      // Don't clobber an explicitly-set process.env value.
      if (process.env[key] === undefined) process.env[key] = p.Value;
      count++;
    }
    nextToken = res.NextToken;
  } while (nextToken);

  console.log(`[secrets] loaded ${count} parameters from SSM ${path}`);
}
