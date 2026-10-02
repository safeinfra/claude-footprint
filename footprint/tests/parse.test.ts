import { describe, expect, test } from 'claude-code/testing'

import { analyze, classifyAws, lex, normalizeKind, parseManifest, redact } from '../hooks/parse'

type Row = [name: string, command: string, expected: { actions: object[]; unparsed?: number }]

const aws = (o: object) => ({ tool: 'aws', ...o })
const k = (o: object) => ({ tool: 'kubectl', ...o })

const ROWS: Row[] = [
  // aws basics and classification
  ['aws describe is read', 'aws ec2 describe-instances --instance-ids i-0abc',
    { actions: [aws({ service: 'ec2', verb: 'describe-instances', cls: 'read', resource: 'i-0abc' })] }],
  ['aws list is read', 'aws lambda list-functions', { actions: [aws({ service: 'lambda', cls: 'read' })] }],
  ['aws get is read', 'aws iam get-role --role-name app', { actions: [aws({ cls: 'read', resource: 'app', isGlobal: true })] }],
  ['aws create is write', 'aws sqs create-queue --queue-name jobs', { actions: [aws({ cls: 'write', resource: 'jobs' })] }],
  ['aws put is write', 'aws s3api put-object --bucket b --key k --body f', { actions: [aws({ cls: 'write', resource: 'b' })] }],
  ['aws run-instances is write', 'aws ec2 run-instances --image-id ami-1', { actions: [aws({ cls: 'write' })] }],
  ['aws stop is write', 'aws ec2 stop-instances --instance-ids i-1', { actions: [aws({ cls: 'write' })] }],
  ['aws terminate is destructive', 'aws ec2 terminate-instances --instance-ids i-9',
    { actions: [aws({ cls: 'destructive', resource: 'i-9' })] }],
  ['aws delete is destructive', 'aws rds delete-db-instance --db-instance-identifier db1 --skip-final-snapshot',
    { actions: [aws({ cls: 'destructive', resource: 'db1' })] }],
  ['aws detach is destructive', 'aws iam detach-role-policy --role-name r --policy-arn arn:aws:iam::aws:policy/X',
    { actions: [aws({ cls: 'destructive' })] }],
  ['aws purge is destructive', 'aws sqs purge-queue --queue-url https://q', { actions: [aws({ cls: 'destructive' })] }],
  // cred overrides
  ['ecr login is cred', 'aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin x',
    { actions: [aws({ service: 'ecr', cls: 'cred', region: 'ap-northeast-1' })] }],
  ['secret value is cred', 'aws secretsmanager get-secret-value --secret-id prod/db',
    { actions: [aws({ cls: 'cred', resource: 'prod/db' })] }],
  ['ssm decrypt is cred', 'aws ssm get-parameter --name /app/key --with-decryption', { actions: [aws({ cls: 'cred' })] }],
  ['ssm without decrypt is read', 'aws ssm get-parameters --names a b', { actions: [aws({ cls: 'read' })] }],
  ['eks token is cred', 'aws eks get-token --cluster-name prod', { actions: [aws({ cls: 'cred' })] }],
  ['session token is cred', 'aws sts get-session-token', { actions: [aws({ cls: 'cred', isGlobal: true })] }],
  ['assume-role links accounts', 'aws sts assume-role --role-arn arn:aws:iam::210987654321:role/Deploy --role-session-name s',
    { actions: [aws({ cls: 'cred', resource: 'Deploy', link: { to: 'aws', account: '210987654321', role: 'Deploy' } })] }],
  // scope
  ['--profile and --region win', 'AWS_PROFILE=a aws --profile b --region us-west-2 ec2 describe-vpcs',
    { actions: [aws({ profile: 'b', region: 'us-west-2' })] }],
  ['inline env prefix profile', 'AWS_PROFILE=acct-a AWS_REGION=eu-west-1 aws ec2 describe-vpcs',
    { actions: [aws({ profile: 'acct-a', region: 'eu-west-1' })] }],
  ['export carries to later commands', 'export AWS_PROFILE=x && aws s3 ls',
    { actions: [aws({ profile: 'x', service: 's3', verb: 'ls', isGlobal: true })] }],
  ['aws-vault exec sets profile', 'aws-vault exec ops -- aws ec2 describe-vpcs', { actions: [aws({ profile: 'ops' })] }],
  ['safe-aws counts as aws', 'safe-aws --profile p rds describe-db-instances', { actions: [aws({ profile: 'p', service: 'rds' })] }],
  ['eks update-kubeconfig links k8s', 'aws eks update-kubeconfig --name prod-eks --region ap-northeast-1',
    { actions: [aws({ cls: 'read', link: { to: 'k8s', cluster: 'prod-eks' } })] }],
  // s3 high level
  ['s3 upload is write', 'aws s3 cp ./build s3://site/app --recursive', { actions: [aws({ cls: 'write', resource: 's3://site/app' })] }],
  ['s3 download is read', 'aws s3 cp s3://logs/2024.gz .', { actions: [aws({ cls: 'read', resource: 's3://logs/2024.gz' })] }],
  ['s3 rm is destructive', 'aws s3 rm s3://b/tmp --recursive', { actions: [aws({ cls: 'destructive', resource: 's3://b/tmp' })] }],
  ['s3 sync --delete is destructive', 'aws s3 sync dist/ s3://site --delete', { actions: [aws({ cls: 'destructive', resource: 's3://site' })] }],
  ['s3 sync upload is write', 'aws s3 sync dist/ s3://site', { actions: [aws({ cls: 'write' })] }],
  ['s3 mv from bucket is destructive', 'aws s3 mv s3://a/k s3://b/k', { actions: [aws({ cls: 'destructive' })] }],
  ['s3 ls bucket is regional read', 'aws s3 ls s3://b/', { actions: [aws({ cls: 'read', isGlobal: false })] }],
  // shell structure
  ['pipes and && split', 'aws ec2 describe-instances | jq . && aws ec2 describe-vpcs || echo x; kubectl get pods',
    { actions: [aws({ verb: 'describe-instances' }), aws({ verb: 'describe-vpcs' }), k({ verb: 'get', kind: 'pods' })] }],
  ['quotes are removed', `aws ec2 describe-instances --filters "Name=tag:Name,Values=web app" --query 'Reservations[].Instances[]'`,
    { actions: [aws({ verb: 'describe-instances' })] }],
  ['$(...) bodies are parsed too', 'kubectl delete pod $(kubectl get pods -l app=x -o name | head -1)',
    { actions: [k({ verb: 'delete', kind: 'pods', cls: 'destructive' }), k({ verb: 'get', kind: 'pods' })] }],
  ['bash -c is unwrapped', `bash -c "aws s3 rm s3://b/x"`, { actions: [aws({ cls: 'destructive' })] }],
  ['redirections are dropped', 'kubectl get pods -n web > /tmp/out 2>&1', { actions: [k({ kind: 'pods', namespace: 'web' })] }],
  ['non-infra commands ignored', 'ls -la && git status | grep aws', { actions: [] }],
  ['unbalanced quote counts as unparsed', `aws ec2 describe-instances --query 'oops`, { actions: [], unparsed: 1 }],
  ['unknown kubectl verb counts as unparsed', 'kubectl frobnicate x', { actions: [], unparsed: 1 }],
  ['aws --version is skipped', 'aws --version', { actions: [], unparsed: 0 }],
  // kubectl
  ['kubectl get with -n', 'kubectl get deploy -n prod', { actions: [k({ kind: 'deployments', namespace: 'prod', cls: 'read' })] }],
  ['kubectl -A is all namespaces', 'kubectl get po -A', { actions: [k({ kind: 'pods', namespace: '*' })] }],
  ['kubectl kind/name and --context', 'kubectl --context prod-eks -n web rollout restart deploy/api',
    { actions: [k({ context: 'prod-eks', namespace: 'web', kind: 'deployments', resource: 'api', verb: 'rollout restart', cls: 'write' })] }],
  ['rollout status is read', 'kubectl rollout status deployment api', { actions: [k({ cls: 'read', resource: 'api' })] }],
  ['scale is write', 'kubectl scale deploy api --replicas 3', { actions: [k({ cls: 'write', kind: 'deployments', resource: 'api' })] }],
  ['delete is destructive', 'kubectl delete pod web-1 --now', { actions: [k({ cls: 'destructive', resource: 'web-1' })] }],
  ['drain is destructive on nodes', 'kubectl drain ip-10-0-0-1 --ignore-daemonsets',
    { actions: [k({ cls: 'destructive', kind: 'nodes', namespace: '(cluster)' })] }],
  ['exec is interactive', 'kubectl exec -it web-1 -c app -- sh -c "ls"', { actions: [k({ cls: 'interactive', kind: 'pods', resource: 'web-1' })] }],
  ['logs -p is a flag not a value', 'kubectl logs -p web-1 -n app', { actions: [k({ kind: 'pods', resource: 'web-1', namespace: 'app' })] }],
  ['port-forward svc', 'kubectl port-forward svc/db 5432:5432', { actions: [k({ cls: 'interactive', kind: 'services', resource: 'db' })] }],
  ['cp pod path with namespace', 'kubectl cp ops/tool-1:/tmp/dump ./dump', { actions: [k({ kind: 'pods', resource: 'tool-1', namespace: 'ops' })] }],
  ['multiple kinds', 'kubectl get po,svc', { actions: [k({ kind: 'pods' }), k({ kind: 'services' })] }],
  ['create secret keeps the name', 'kubectl create secret generic db --from-literal=password=hunter2',
    { actions: [k({ kind: 'secrets', resource: 'db', cls: 'write' })] }],
  ['create token is cred', 'kubectl create token deployer', { actions: [k({ cls: 'cred', kind: 'serviceaccounts' })] }],
  ['get secret -o yaml is cred', 'kubectl get secret db -o yaml', { actions: [k({ cls: 'cred', kind: 'secrets' })] }],
  ['apply -f file waits for the manifest', 'cd deploy && kubectl apply -f api.yaml',
    { actions: [k({ kind: 'manifest', file: 'api.yaml', cwd: 'deploy', cls: 'write' })] }],
  ['apply -f - takes a heredoc', 'cat <<EOF | kubectl apply -n web -f -\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n---\nkind: Service\nmetadata:\n  name: api\n  namespace: edge\nEOF',
    { actions: [k({ kind: 'configmaps', resource: 'cfg', namespace: 'web' }), k({ kind: 'services', resource: 'api', namespace: 'edge' })] }],
  ['config use-context is read and switches', 'kubectl config use-context staging',
    { actions: [k({ kind: 'config', cls: 'read', useContext: 'staging' })] }],
  ['set image ignores the image ref', 'kubectl set image deploy/api api=123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/api:v2',
    { actions: [k({ verb: 'set image', kind: 'deployments', resource: 'api', cls: 'write' })] }],
  ['resource is redacted', 'aws iam update-access-key --access-key-id AKIAABCDEFGHIJKLMNOP --status Inactive',
    { actions: [aws({ cls: 'write', resource: 'AKIA****************' })] }],
  ['sudo/timeout wrappers', 'sudo -E timeout 30 kubectl get nodes', { actions: [k({ kind: 'nodes', namespace: '(cluster)' })] }],
]

describe('analyze', () => {
  for (const [name, command, expected] of ROWS) {
    test(name, () => {
      const got = analyze(command)
      expect(got.actions).toMatchObject(expected.actions)
      expect(got.actions).toHaveLength(expected.actions.length)
      if (expected.unparsed !== undefined) expect(got.unparsed).toBe(expected.unparsed)
    })
  }
})

describe('classifyAws', () => {
  const table: [string, string, string][] = [
    ['ec2', 'modify-instance-attribute', 'write'],
    ['ec2', 'reboot-instances', 'write'],
    ['iam', 'attach-role-policy', 'write'],
    ['ec2', 'associate-address', 'write'],
    ['logs', 'filter-log-events', 'read'],
    ['autoscaling', 'deregister-instances-from-load-balancer', 'destructive'],
    ['sts', 'assume-role-with-web-identity', 'cred'],
  ]
  for (const [service, op, cls] of table) {
    test(`${service} ${op} is ${cls}`, () => expect(classifyAws(service, op)).toBe(cls))
  }
})

describe('helpers', () => {
  test('normalizeKind', () => {
    expect(['po', 'Deployment', 'NetworkPolicy', 'Ingress', 'endpoints', 'certificates.cert-manager.io'].map(normalizeKind))
      .toEqual(['pods', 'deployments', 'networkpolicies', 'ingresses', 'endpoints', 'certificates'])
  })
  test('parseManifest reads JSON lists', () => {
    expect(parseManifest('{"kind":"List","items":[{"kind":"Pod","metadata":{"name":"a"}}]}'))
      .toEqual([{ kind: 'Pod', name: 'a', namespace: undefined }])
  })
  test('lex keeps $(...) literal in the word', () => {
    const lx = lex('echo "$(date)" x')
    expect(lx.ok).toBe(true)
    if (lx.ok) expect(lx.commands[0]?.words).toEqual(['echo', '$(date)', 'x'])
  })
})

describe('redact', () => {
  const table: [string, string, string][] = [
    ['secret-string', `aws secretsmanager put-secret-value --secret-id x --secret-string '{"p":"s3cr3t"}'`,
      'aws secretsmanager put-secret-value --secret-id x --secret-string ***'],
    ['password flag', 'mysql --password=hunter2 -h db', 'mysql --password=*** -h db'],
    ['token flag', 'kubectl --token abc.def get pods', 'kubectl --token *** get pods'],
    ['from-literal keeps key', 'kubectl create secret generic db --from-literal=password=hunter2 --from-literal user=admin',
      'kubectl create secret generic db --from-literal=password=*** --from-literal user=***'],
    ['parameter-overrides', 'aws cloudformation deploy --parameter-overrides DbPass=x Env=prod --stack-name s',
      'aws cloudformation deploy --parameter-overrides *** --stack-name s'],
    ['cli-input-json', `aws ec2 run-instances --cli-input-json '{"a":1}'`, 'aws ec2 run-instances --cli-input-json ***'],
    ['env prefix', 'GITHUB_TOKEN=ghp_x API_KEY="a b" aws s3 ls', 'GITHUB_TOKEN=*** API_KEY=*** aws s3 ls'],
    ['access key id', 'echo AKIAABCDEFGHIJKLMNOP', 'echo AKIA****************'],
    ['ssm put-parameter value', 'aws ssm put-parameter --name /x --value s3cr3t --type SecureString',
      'aws ssm put-parameter --name /x --value *** --type SecureString'],
    ['--key= is a name, not a secret', 'aws s3api get-object --bucket b --key=path/obj out', 'aws s3api get-object --bucket b --key=path/obj out'],
    ['names stay','aws secretsmanager get-secret-value --secret-id prod/db', 'aws secretsmanager get-secret-value --secret-id prod/db'],
  ]
  for (const [name, input, output] of table) {
    test(name, () => expect(redact(input)).toBe(output))
  }
})
