/**
 * Made-up repos of each shape for the install's Read (ADR 0026): a tenant config deployed by CI on
 * every push to main (dev, then test, then prod), a web app, a library, a CDK infrastructure repo
 * and a monorepo mixing them. Path from the repo's top → text. Every name, host and key is made
 * up; the values in the mapping files are test ones, and the rendered config and env files hold a
 * marker Read must never read (`NEVER_READ_MARK`).
 */

/** What a file Read must never read holds: a test fails when it shows up anywhere. */
export const NEVER_READ_MARK = 'hunter2-never-read';

const DEPLOY_JOB = (env: string, needs: string) => `  deploy_${env}:
    name: deploy-${env}
    needs: [${needs}]
    runs-on: ubuntu-latest
    environment: ${env}
    steps:
      - uses: actions/checkout@v4
      - name: Export secrets
        env:
          AUTH0_CLIENT_SECRET: \${{ secrets.AUTH0_CLIENT_SECRET }}
        run: echo "AUTH0_CLIENT_SECRET=$AUTH0_CLIENT_SECRET" >> "$GITHUB_ENV"
      - run: npm ci --no-audit
      - name: Render the config
        run: node scripts/render-config.js config.${env}.json config.generated.json
      - name: Deploy ${env}
        run: |
          echo "## ${env} deploy"
          npx a0deploy deploy -c config.generated.json -i src/tenant.yaml
`;

/** A login tenant's config as code, deployed by a0deploy on every push to main. */
export const TENANT_REPO: Readonly<Record<string, string>> = {
  'README.md': '# acme-login\n\nThe login tenant of the acme shop, as code.\n',
  '.gitignore': 'node_modules/\nconfig.generated.json\n.env\n',
  '.nvmrc': '24\n',
  'package.json': `{
  "name": "acme-login",
  "private": true,
  "scripts": {
    "test": "echo \\"Error: no test specified\\" && exit 1",
    "preview:login": "bash ./scripts/preview.sh login.html 3021",
    "sync:vars": "node scripts/sync-vars.js"
  },
  "dependencies": { "axios": "^1.7.0" }
}
`,
  Dockerfile:
    'FROM node:24-slim\nRUN npm install --location=global auth0-deploy-cli\nWORKDIR /work\n',
  'config.template.json': `{
  "AUTH0_DOMAIN": "<domain>",
  "AUTH0_KEYWORD_REPLACE_MAPPINGS": {
    "ENVIRONMENT": "<env>",
    "SHOP_DOMAIN": "<domain>",
    "SENDGRID_API_KEY": "<key>"
  }
}
`,
  'config.dev.json':
    '{\n  "AUTH0_KEYWORD_REPLACE_MAPPINGS": {\n    "ENVIRONMENT": "dev",\n    "SHOP_DOMAIN": "dev.shop.example.test",\n    "SENDGRID_API_KEY": "SG.test"\n  }\n}\n',
  'config.test.json':
    '{\n  "AUTH0_KEYWORD_REPLACE_MAPPINGS": {\n    "ENVIRONMENT": "test",\n    "SHOP_DOMAIN": "test.shop.example.test",\n    "SENDGRID_API_KEY": "SG.test"\n  }\n}\n',
  'config.prod.json':
    '{\n  "AUTH0_KEYWORD_REPLACE_MAPPINGS": {\n    "ENVIRONMENT": "prod",\n    "SHOP_DOMAIN": "shop.example.test",\n    "SENDGRID_API_KEY": "SG.test"\n  }\n}\n',
  'config.generated.json': `{ "AUTH0_CLIENT_SECRET": "${NEVER_READ_MARK}" }\n`,
  '.env': `AUTH0_CLIENT_SECRET=${NEVER_READ_MARK}\n`,
  'src/tenant.yaml': `tenant:
  friendly_name: acme login ##ENVIRONMENT##
  support_url: https://##SHOP_DOMAIN##/help
emailProvider:
  name: sendgrid
  credentials:
    api_key: '##SENDGRID_API_KEY##'
`,
  'src/actions/add-claims/code.js':
    'exports.onExecutePostLogin = async (event, api) => {\n  api.idToken.setCustomClaim("shop", event.user.email);\n};\n',
  'src/pages/login.html': '<script>var config = JSON.parse(atob("@@config@@"));</script>\n',
  'scripts/preview.sh': '#!/bin/sh\nnode -e "require(\\"http\\")" "$1" "$2"\n',
  'scripts/render-config.js':
    'const fs = require("fs");\nfs.copyFileSync(process.argv[2], process.argv[3]);\n',
  'scripts/sync-vars.js': 'console.log("syncs variables");\n',
  '.github/workflows/deploy.yml': `name: Deploy the tenant
on:
  push:
    branches:
      - main
      - hotfix/**
jobs:
  prepare:
    runs-on: ubuntu-latest
    steps:
      - run: echo "## promotion" >> "$GITHUB_STEP_SUMMARY"
${DEPLOY_JOB('dev', 'prepare')}${DEPLOY_JOB('test', 'deploy_dev')}${DEPLOY_JOB('prod', 'deploy_test')}`,
};

/** A web shop's front end: checked on pull requests, deployed by hand. */
export const WEB_REPO: Readonly<Record<string, string>> = {
  'package.json':
    '{\n  "name": "acme-shop",\n  "scripts": { "dev": "vite --port 5173", "test": "vitest run" },\n  "dependencies": { "react": "19.0.0", "react-dom": "19.0.0", "@sentry/react": "9.0.0" },\n  "devDependencies": { "vite": "7.0.0", "vitest": "3.0.0" }\n}\n',
  '.env.example': 'VITE_API_URL=http://localhost:4000\n',
  '.github/workflows/ci.yml':
    'on: [pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n',
  '.github/workflows/release.yml':
    'on: workflow_dispatch\njobs:\n  deploy:\n    environment: production\n    steps:\n      - run: npm run deploy\n',
};

/** A library published by hand: nothing deploys, nothing runs. */
export const LIBRARY_REPO: Readonly<Record<string, string>> = {
  'package.json':
    '{\n  "name": "@acme/strings",\n  "main": "dist/index.js",\n  "types": "dist/index.d.ts",\n  "scripts": { "build": "tsc", "test": "vitest run" },\n  "devDependencies": { "typescript": "5.9.0", "vitest": "3.0.0" }\n}\n',
  'tsconfig.json': '{ "compilerOptions": { "outDir": "dist" } }\n',
  'src/index.ts': 'export const shout = (s: string) => s.toUpperCase();\n',
  '.github/workflows/ci.yml':
    'on:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n',
};

const CDK_JOB = (env: string, needs: string) => `  deploy_${env}:
    needs: ${needs}
    runs-on: ubuntu-latest
    environment: ${env}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::000000000000:role/deploy-${env}
      - run: npm ci
      - name: Deploy the stacks
        run: |
          npx cdk deploy Shop-Network --require-approval never
          npx cdk deploy Shop-Database --require-approval never
`;

/**
 * AWS CDK infrastructure: no app server, a CloudFront function with its own test, deployed by CI
 * on every push to main; its CI image installs a deploy tool it never runs; its CDK lookups and
 * synthesized templates sit beside it, never read.
 */
export const CDK_REPO: Readonly<Record<string, string>> = {
  'README.md': '# acme-infrastructure\n\nThe shop’s AWS stacks.\n',
  'package.json': `{
  "name": "acme-infrastructure",
  "bin": { "infrastructure": "bin/infrastructure.js" },
  "scripts": {
    "test": "node --test",
    "typecheck": "tsc --noEmit",
    "cdk": "cdk",
    "deploy:network": "dotenv -e .env.aws.dev -- cdk deploy Shop-Network --require-approval never"
  },
  "dependencies": {
    "@aws-cdk/aws-servicecatalogappregistry-alpha": "2.0.0-alpha.0",
    "aws-cdk-lib": "2.200.0",
    "constructs": "10.0.0",
    "dotenv": "16.0.0"
  },
  "devDependencies": { "aws-cdk": "2.1000.0", "tsx": "4.0.0", "typescript": "5.9.0" }
}
`,
  'cdk.json': '{ "app": "npx tsx bin/infrastructure.ts" }\n',
  'cdk.context.json': `{ "vpc-provider:account=000000000000": "${NEVER_READ_MARK}" }\n`,
  'cdk.out/manifest.json': `{ "${NEVER_READ_MARK}": true }\n`,
  'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
  Dockerfile: 'FROM node:24-slim\nRUN npm install --location=global auth0-deploy-cli aws-cdk\n',
  'bin/infrastructure.ts': 'import "dotenv/config";\n',
  'lib/images-function.mjs': 'export const handler = (event) => event.request;\n',
  'lib/images-function.test.mjs': 'import test from "node:test";\ntest("rewrites", () => {});\n',
  '.github/workflows/deploy.yml': `name: Deploy the infrastructure
on:
  push:
    branches: [main]
jobs:
${CDK_JOB('dev', '[]')}${CDK_JOB('test', 'deploy_dev')}${CDK_JOB('prod', 'deploy_test')}`,
  '.github/workflows/bootstrap.yml':
    'on:\n  workflow_dispatch:\n    inputs:\n      environment: { type: string }\njobs:\n  bootstrap:\n    steps:\n      - run: npx cdk bootstrap\n',
};

/**
 * A monorepo mixing them: a web app, an API service in a container, a UI library, a function with
 * its own CDK stack (a service), a CDK stack alone, and Terraform at the top; a push to main
 * deploys staging only.
 */
export const MONOREPO: Readonly<Record<string, string>> = {
  'package.json':
    '{\n  "name": "acme",\n  "private": true,\n  "workspaces": ["apps/*", "packages/*", "services/*"],\n  "devDependencies": { "turbo": "2.0.0" }\n}\n',
  'apps/web/package.json':
    '{\n  "name": "web",\n  "scripts": { "dev": "next dev" },\n  "dependencies": { "next": "15.0.0", "react-dom": "19.0.0" }\n}\n',
  'packages/ui/package.json':
    '{\n  "name": "@acme/ui",\n  "exports": "./src/index.ts",\n  "scripts": { "test": "vitest run" }\n}\n',
  'services/api/package.json':
    '{\n  "name": "api",\n  "scripts": { "dev": "tsx watch src/server.ts" },\n  "dependencies": { "zod": "4.0.0" }\n}\n',
  // a function and its own stack: a service, not infrastructure
  'services/mail/package.json':
    '{\n  "name": "mail",\n  "scripts": { "test": "vitest run" },\n  "dependencies": { "aws-cdk-lib": "2.200.0" }\n}\n',
  'services/mail/cdk.json': '{ "app": "npx tsx cdk/app.ts" }\n',
  'services/mail/cdk/app.ts': 'export {};\n',
  'services/mail/src/handler.ts': 'export const handler = async () => ({ statusCode: 200 });\n',
  // its stack alone: infrastructure
  'services/network/package.json':
    '{\n  "name": "network",\n  "dependencies": { "aws-cdk-lib": "2.200.0" }\n}\n',
  'services/network/cdk.json': '{ "app": "npx tsx bin/network.ts" }\n',
  'services/network/bin/network.ts': 'export {};\n',
  'services/api/Dockerfile':
    'FROM node:24-slim\nCOPY . .\nEXPOSE 8080\nCMD ["node", "dist/server.js"]\n',
  'infra/main.tf': 'terraform {\n  backend "s3" {}\n}\nresource "null_resource" "network" {}\n',
  'infra/prod.tfvars': `token = "${NEVER_READ_MARK}"\n`,
  '.github/workflows/deploy.yml':
    'on:\n  push:\n    branches: [main]\njobs:\n  checks:\n    runs-on: ubuntu-latest\n    environment: staging\n    steps:\n      - run: npm run lint\n  deploy-staging:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx turbo run deploy -- --stage staging\n',
  '.github/workflows/prod.yml':
    'on: workflow_dispatch\njobs:\n  deploy-prod:\n    environment: prod\n    steps:\n      - run: npx turbo run deploy:prod\n',
};
