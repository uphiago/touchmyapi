# TouchMyAPI Foundation Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sanear a fundação do TouchMyAPI e entregar T010–T021: política pura default-deny, PostgreSQL 16 com isolamento RLS real, persistência de auditoria, AEAD de credenciais, catálogo passivo e fronteira Hono com sessões Google OAuth PKCE.

**Architecture:** `packages/contracts` define os formatos compartilhados; `packages/policy`, `packages/secrets` e `packages/playbooks` são bibliotecas puras que não executam alvos. `packages/db` mantém migrações, funções bootstrap e transações tenant-scoped usando roles PostgreSQL sem privilégios de proprietário; `apps/api` apenas coordena adaptadores validados e expõe saúde e autenticação. A implementação é entregue em cinco gates, sem assessment, fila, runner, billing, relatório, scanner, target fetch ou agente privado.

**Checkpoint 2026-08-22:** os passos de Task 1–9 foram executados. T010–T016 estão aceitas; T016 substituiu `TenantConnection.unsafe(string)` por `TenantDatabase` opaco e capacidades fechadas, incluindo provas de grants concorrentes. T017–T021 não foram iniciadas. Consulte `docs/reviews/2026-08-22-t016-capability-boundary.md`. Os checkboxes abaixo registram execução dos passos; `specs/001-touchmyapi-platform/tasks.md` registra aceite.

**Tech Stack:** Bun 1.4.0, TypeScript strict, Vitest, Hono, Zod, Drizzle ORM/drizzle-kit, PostgreSQL 16, `postgres`, `openid-client`, Web Crypto/Node `crypto`, Docker Compose, GitHub Actions, React/Vite existente.

---

## Contexto e limites que não podem mudar

- A constituição é a autoridade final: autorização explícita, policy como autoridade, RLS default-deny, menor privilégio, AI não-executora e billing somente por webhook permanecem obrigatórios.
- O único método que poderá autorizar execução externa nesta fase futura é `http_file`; `dns_txt` continua reservado no enum, mas sempre negado pela policy.
- Não criar assessment CRUD, máquina de estados de assessment, fila, worker, sandbox, safe-fetch, probe de alvo, Stripe, entitlement mutation, reports, downloads de objetos, provider de AI ou private agent.
- Não adicionar feature de frontend; preserve apenas o shell de saúde existente.
- Toda etapa abaixo termina com teste focado, teste verde, `git diff --check` e commit pequeno. Um commit só pode conter os caminhos da tarefa indicada.

## Mapa de arquivos e responsabilidades

| Área | Arquivos criados ou modificados | Responsabilidade única |
| --- | --- | --- |
| Saneamento | `.github/workflows/ci.yml`, `.gitignore`, `.husky/pre-commit`, `vitest.config.ts`, `tsconfig.json`, `package.json`, `drizzle.config.ts`, `packages/db/scripts/migrate.ts`, `.env.example`, `infra/docker/compose.yml`, `specs/001-touchmyapi-platform/atlas.html`, `README.md`, `specs/001-touchmyapi-platform/quickstart.md` | Versão Bun, gates CI, topologia de testes, configuração explícita e infraestrutura reproduzível |
| Policy | `packages/policy/package.json`, `packages/policy/src/{scope,entitlement,limits,engine,index}.ts`, `packages/policy/test/*.test.ts`, `tests/isolation/policy.test.ts` | Normalização, direitos, redução de limites e decisão final sem I/O |
| DB/RLS | `packages/db/package.json`, `packages/db/schema/*.ts`, `packages/db/migrations/*.sql`, `packages/db/src/{index,connection-internal,tenant-session,tenant-account,tenant-internal}.ts`, `packages/db/test/*.test.ts`, `tests/isolation/*.test.ts` | Schema/roles/RLS/auth bootstrap e boundary fechado de tenant implementados; audit writer pendente |
| Secrets | `packages/secrets/package.json`, `packages/secrets/src/{aead,index}.ts`, `packages/secrets/test/aead.test.ts` | Envelope AEAD injetável e redaction-safe |
| Playbooks | `packages/playbooks/package.json`, `packages/playbooks/src/{index,surface-public-posture}.ts`, `packages/playbooks/test/*.test.ts` | Contrato versionado e slice passivo fechado, sem execução |
| API/OAuth | `apps/api/package.json`, `apps/api/src/{app,config,error,request-id,session,server}.ts`, `apps/api/src/auth/{oidc-adapter,google,transient-cookie}.ts`, `apps/api/test/{app,oauth}.test.ts` | Factory Hono, erros seguros, CORS, sessão opaca e adapter OAuth fakeável |

## Gate 0 — fundação reproduzível e saneamento do review

### Task 1: Fixar runtime, lockfile, strict tests e suites nomeadas

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`
- Modify: `.gitignore`
- Modify: `.husky/pre-commit`
- Create: `.github/workflows/ci.yml`
- Create: `tests/e2e/pending.test.ts`
- Create: `tests/isolation/no-execution-surface.test.ts`
- Test: `scripts/verify-workspace.ts`

- [x] **Step 1: Escrever o teste de topologia que falha**

Crie `tests/unit/test-topology.test.ts` e verifique que cada arquivo existente pertence ao projeto correto e que o suite e2e fica explicitamente skipped:

```ts
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";

describe("foundation test topology", () => {
  it("keeps named security suites present", () => {
    expect(existsSync("tests/contract")).toBe(true);
    expect(existsSync("tests/integration")).toBe(true);
    expect(existsSync("tests/isolation")).toBe(true);
    expect(existsSync("tests/e2e/pending.test.ts")).toBe(true);
  });
});
```

Execute `bun run test:contract`; resultado esperado antes da correção: falha com `No test files found`.

- [x] **Step 2: Corrigir scripts, include strict e projetos Vitest**

No `package.json`, acrescente scripts determinísticos e fixe o runtime:

```json
{
  "packageManager": "bun@1.4.0",
  "engines": { "bun": "1.4.0" },
  "scripts": {
    "test:unit": "vitest run --project unit",
    "test:contract": "vitest run --project contract",
    "test:integration": "vitest run --project integration",
    "test:isolation": "vitest run --project isolation",
    "test:e2e": "vitest run --project e2e",
    "verify:workspace": "bun scripts/verify-workspace.ts"
  }
}
```

Mantenha as dependências já existentes e não introduza versões flutuantes novas. Em `tsconfig.json`, use exatamente:

```json
{
  "extends": "./packages/tsconfig/base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["apps", "packages", "tests", "scripts"],
  "exclude": ["node_modules", "dist"]
}
```

Substitua `vitest.config.ts` por projetos sem sobreposição:

```ts
import { defineConfig } from "vitest/config";

const project = (name: string, include: string[], passWithNoTests = false) => ({
  test: { name, include, passWithNoTests },
});

export default defineConfig({
  test: {
    projects: [
      project("unit", ["tests/unit/**/*.test.ts", "apps/**/test/**/*.test.ts", "packages/policy/test/**/*.test.ts", "packages/secrets/test/**/*.test.ts", "packages/**/test/**/*.unit.test.ts"]),
      project("contract", ["tests/contract/**/*.test.ts", "packages/contracts/test/**/*.test.ts", "packages/playbooks/test/**/*.test.ts"]),
      project("integration", ["tests/integration/**/*.test.ts", "packages/db/test/**/*.integration.test.ts", "apps/**/test/**/*.integration.test.ts"]),
      project("isolation", ["tests/isolation/**/*.test.ts", "packages/db/test/**/*.isolation.test.ts"]),
      project("e2e", ["tests/e2e/**/*.test.ts"], true),
    ],
  },
});
```

Renomeie `packages/db/test/connection.test.ts` para `packages/db/test/connection.integration.test.ts`. Os testes de `apps/api/test` permanecem unitários pelo glob explícito; `packages/contracts/test` pertence somente a contract. `tests/e2e/pending.test.ts` deve ser visível como pendente, não como prova de segurança:

```ts
import { describe, it } from "vitest";

describe.skip("future product e2e", () => {
  it("is intentionally not implemented in Foundation Phase 2", () => undefined);
});
```

Crie uma prova de isolamento real para o scaffold em `tests/isolation/no-execution-surface.test.ts`; ela permanece válida até a fase que implementar assessment routes:

```ts
import { describe, expect, it } from "vitest";
import { app } from "../../apps/api/src/app";

describe("foundation execution boundary", () => {
  it("does not expose assessment or execution routes", async () => {
    for (const path of ["/api/v1/assessments", "/api/v1/jobs", "/api/v1/run"]) {
      expect((await app.request(path)).status).toBe(404);
    }
  });
});
```

O hook pode ser conveniente localmente, mas só ignora Bun ausente; com Bun presente, propaga erro:

```sh
#!/usr/bin/env sh
if ! command -v bunx >/dev/null 2>&1; then
  exit 0
fi
bunx lint-staged
```

- [x] **Step 3: Adicionar CI obrigatório**

Crie `.github/workflows/ci.yml` com Bun fixado, Postgres 16 real e todos os gates:

```yaml
name: foundation
on:
  push:
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: touchmyapi_test
          POSTGRES_USER: touchmyapi_migrate
          POSTGRES_PASSWORD: ci-only-password
        ports: ["5432:5432"]
        options: >-
          --health-cmd="pg_isready -U touchmyapi_migrate -d touchmyapi_test"
          --health-interval=5s --health-timeout=5s --health-retries=20
    env:
      DATABASE_URL: postgres://touchmyapi_migrate:ci-only-password@127.0.0.1:5432/touchmyapi_test
      RUN_DB_TESTS: "1"
      NODE_ENV: test
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.4.0" }
      - run: bun install --frozen-lockfile
      - run: bun run verify:workspace
      - run: bun run db:migrate
      - run: bun run test:unit
      - run: bun run test:contract
      - run: bun run test:integration
      - run: bun run test:isolation
      - run: bun run test:e2e
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run format
      - run: bun run --cwd apps/web build
      - run: docker compose -f infra/docker/compose.yml config
      - run: git diff --check
```

O job deve falhar se migrations ou RLS tests forem pulados; o único suite explicitamente pending é e2e.

- [x] **Step 4: Verificar RED/GREEN**

Execute `bun run test:contract`, `bun run test:integration`, `bun run test:isolation`, `bun run typecheck`; resultado esperado GREEN (integration pode depender do Postgres local somente fora CI, e CI define `RUN_DB_TESTS=1`). Execute `bun run test:e2e`; resultado esperado `1 skipped`, exit 0. Execute `bun run lint` e `bun run format`; ambos devem sair 0.

- [x] **Step 5: Commitar**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .husky/pre-commit .github/workflows/ci.yml tests/unit/test-topology.test.ts tests/e2e/pending.test.ts tests/isolation/no-execution-surface.test.ts apps/api/test packages/contracts/test packages/db/test
git commit -m "ci: make foundation test gates reproducible"
```

### Task 2: Remover contradições de autorização e fallbacks de infraestrutura

**Files:**
- Modify: `specs/001-touchmyapi-platform/atlas.html`
- Modify: `drizzle.config.ts`
- Modify: `packages/db/scripts/migrate.ts`
- Modify: `.env.example`
- Modify: `infra/docker/compose.yml`
- Create: `infra/docker/postgres/init/002_test_database.sql`
- Modify: `README.md`
- Modify: `specs/001-touchmyapi-platform/quickstart.md`
- Test: `tests/contract/foundation-config.test.ts`

- [x] **Step 1: Escrever testes negativos**

Crie o teste que falha enquanto os artefatos antigos persistirem:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("foundation configuration", () => {
  it("never presents dns_txt as an authorization method", () => {
    const atlas = readFileSync("specs/001-touchmyapi-platform/atlas.html", "utf8");
    expect(atlas).not.toMatch(/DNS\s+TXT[^\n]{0,80}(autoriza|accepted|verification)/i);
  });

  it("uses immutable MinIO and no Drizzle URL fallback", () => {
    const compose = readFileSync("infra/docker/compose.yml", "utf8");
    expect(compose).not.toContain("minio/minio:latest");
    expect(readFileSync("drizzle.config.ts", "utf8")).not.toContain("??");
  });
});
```

Execute `bun run test:contract -- foundation-config`; resultado esperado RED no estado atual.

- [x] **Step 2: Corrigir artefato e configuração**

No atlas, remova a frase que enumera DNS-TXT como prova de controle e deixe somente a regra HTTP-file. Em `drizzle.config.ts`, substitua a configuração de credenciais por:

```ts
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for migrations");

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/schema/*.ts",
  out: "./packages/db/migrations",
  dbCredentials: { url: databaseUrl },
});
```

Em `packages/db/scripts/migrate.ts`, falhe com status 1 quando `DATABASE_URL` não existir; nunca mostre senha no erro:

```ts
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required for migrations");
  process.exit(1);
}
const migration = Bun.spawn({
  cmd: ["bunx", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
  cwd: new URL("../../../", import.meta.url).pathname,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await migration.exited);
```

No Compose, mantenha Postgres 16 loopback e fixe a lista multi-arch oficial do MinIO em `minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`; registre tag e digest no comentário da linha. O digest foi verificado no registry com `docker buildx imagetools inspect`. Senhas previsíveis ficam somente sob `profiles: [local]`, nunca como fallback de aplicação. Em `.env.example`, substitua `DATABASE_URL` preenchida por `DATABASE_URL=` e documente que Compose local exige o arquivo de ambiente local. Crie `002_test_database.sql` com `CREATE DATABASE touchmyapi_test;`, executado apenas na inicialização de um volume local novo; o database principal continua `touchmyapi`.

Atualize README/quickstart para dizer que `bun run db:migrate` requer URL explícita, CI é obrigatório e `docker compose -f infra/docker/compose.yml config` deve passar. Não marque T007/T008/T010–T021 como concluídos enquanto não houver evidência.

- [x] **Step 3: Verificar GREEN e configuração Docker**

Execute `bun run test:contract -- foundation-config`; esperado PASS. Execute `env -u DATABASE_URL bun run db:migrate`; esperado exit 1 com `DATABASE_URL is required for migrations`. Execute `docker compose -f infra/docker/compose.yml config`; esperado configuração válida, sem bind público e sem tag `latest`.

- [x] **Step 4: Commitar**

```bash
git add specs/001-touchmyapi-platform/atlas.html drizzle.config.ts packages/db/scripts/migrate.ts .env.example infra/docker/compose.yml infra/docker/postgres/init/002_test_database.sql README.md specs/001-touchmyapi-platform/quickstart.md tests/contract/foundation-config.test.ts
git commit -m "fix: close foundation configuration contradictions"
```

## Gate 1 — policy authority (T010–T013)

### Task 3: Criar pacote e normalização de scope (T010)

**Files:**
- Create: `packages/policy/package.json`
- Create: `packages/policy/src/scope.ts`
- Create: `packages/policy/src/index.ts`
- Create: `packages/policy/test/scope.test.ts`
- Create: `tests/isolation/policy.test.ts`

- [x] **Step 1: Escrever testes RED table-driven**

Em `packages/policy/test/scope.test.ts`, cubra URLs HTTP/HTTPS, rejeição de userinfo/fragmento, lower-case/IDN/trailing dot/default port/path, domínio versus URL, todos os ranges proibidos, metadata host, IPv4-mapped IPv6, wildcard somente no label esquerdo, inclusão/exclusão e endereço resolvido obrigatório. O corpo mínimo dos casos deve ser:

```ts
import { describe, expect, it } from "vitest";
import { normalizeExternalUrl, normalizeSurfaceHost, isForbiddenAddress, compileScope, matchesScope } from "../src/scope";

describe("scope normalization", () => {
  it("canonicalizes a public URL", () => {
    expect(normalizeExternalUrl("HTTPS://Example.COM:443/a/../b#ignored")).toEqual({
      ok: false,
      code: "fragment_not_allowed",
    });
    expect(normalizeExternalUrl("HTTPS://Example.COM:443/a/../b")).toEqual({
      ok: true,
      value: { url: "https://example.com/b", hostname: "example.com", port: 443, path: "/b", protocol: "https:" },
    });
  });

  it("rejects private, metadata and malformed targets", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "::ffff:192.168.1.1"]) {
      expect(isForbiddenAddress(address)).toBe(true);
    }
    expect(normalizeSurfaceHost("http://example.com").ok).toBe(false);
    expect(normalizeSurfaceHost("metadata.google.internal").ok).toBe(false);
  });

  it("makes exclusions win and does not use substring wildcards", () => {
    const scope = compileScope({ inclusions: ["*.example.com/*"], exclusions: ["private.example.com/admin/*"] });
    expect(matchesScope(scope, "https://api.example.com/v1")).toBe(true);
    expect(matchesScope(scope, "https://private.example.com/admin/users")).toBe(false);
    expect(matchesScope(scope, "https://notexample.com/")).toBe(false);
  });
});
```

`tests/isolation/policy.test.ts` deve também afirmar que string de domínio que resolva futuramente não autoriza network capability sem `resolvedAddresses` não vazio e que qualquer endereço proibido nega o conjunto inteiro. Execute `bun run test:unit -- scope` e `bun run test:isolation -- policy`; esperado RED.

- [x] **Step 2: Implementar os tipos e funções puras**

Adicione `packages/policy/package.json` com `@touchmyapi/contracts` workspace e dependência `zod`; o módulo não pode importar `dns`, filesystem, HTTP ou `process.env`. A API pública deve ser:

```ts
export type ScopeRule = { host: string; port: number | null; pathPrefix: string; wildcard: boolean };
export type CompiledScope = { inclusions: ScopeRule[]; exclusions: ScopeRule[] };
export type NormalizedTarget = { url: string; hostname: string; port: number; path: string; protocol: "http:" | "https:" };
export type ScopeResult<T> = { ok: true; value: T } | { ok: false; code: string };
export function normalizeExternalUrl(input: string): ScopeResult<NormalizedTarget>;
export function normalizeSurfaceHost(input: string): ScopeResult<{ hostname: string }>;
export function isForbiddenAddress(input: string): boolean;
export function compileScope(input: { inclusions: string[]; exclusions: string[] }): CompiledScope;
export function matchesScope(scope: CompiledScope, candidate: string): boolean;
```

Use `URL` para canonicalização, `net.isIP` para IP literal, parser numérico para IPv4/IPv6 e regras explícitas para unspecified, loopback, RFC1918, link-local, CGNAT, documentação/teste, benchmark, multicast, reservado, ULA, IPv4-mapped e `169.254.169.254`; rejeite `metadata.google.internal`, `metadata`, `instance-data` e equivalentes sem fazer resolução. Só aceite wildcard quando o primeiro label completo for `*`; nunca use regex livre. `compileScope` canonicaliza regra e `matchesScope` testa exclusão primeiro.

- [x] **Step 3: Rodar GREEN e typecheck**

Execute `bun run test:unit -- scope`, `bun run test:isolation -- policy` e `bun run typecheck`; esperado PASS. Confirme por busca que `packages/policy/src` não contém `fetch(`, `Bun.env`, `process.env`, `dns`, `fs` ou imports de `apps`.

- [x] **Step 4: Commitar**

```bash
git add packages/policy tests/isolation/policy.test.ts
git commit -m "feat: add pure external scope policy"
```

### Task 4: Implementar entitlement rights e redução de limites (T011–T012)

**Files:**
- Create: `packages/policy/src/entitlement.ts`
- Create: `packages/policy/src/limits.ts`
- Create: `packages/policy/test/entitlement.test.ts`
- Create: `packages/policy/test/limits.test.ts`
- Modify: `packages/policy/src/index.ts`

- [x] **Step 1: Escrever RED para matriz e não-escalada**

Os testes devem iterar todos os planos e afirmar exatamente: `free_unverified` só aggregate/passive; `free_verified` título/categoria/severity e introductory; `pro`/`lifetime` details, reports, scheduling, history; caps de crédito 1/1/10/10. Limites ausentes negam; input menor reduz; input maior não aumenta; arrays de egress nunca ampliam default-deny.

```ts
import { describe, expect, it } from "vitest";
import { rightsForPlan } from "../src/entitlement";
import { reduceLimits } from "../src/limits";

describe("entitlements and limit reduction", () => {
  it("returns immutable conservative rights", () => {
    expect(rightsForPlan("free_unverified")).toEqual({ visibility: "aggregate", playbookSlice: "passive", maxCredits: 1, reports: false, scheduling: false, history: false });
    expect(rightsForPlan("free_verified").visibility).toBe("masked");
    expect(rightsForPlan("pro").maxCredits).toBe(10);
    expect(rightsForPlan("lifetime").reports).toBe(true);
  });

  it("only reduces authoritative limits", () => {
    const result = reduceLimits({ playbook: { durationS: 300, concurrency: 2, ratePerMin: 10, credits: 10, egress: ["scope_target"] }, entitlement: { durationS: 120, concurrency: 1, ratePerMin: 5, credits: 10 }, account: { durationS: 90, concurrency: 1, ratePerMin: 4, credits: 3 }, requested: { durationS: 200, concurrency: 3, ratePerMin: 9, credits: 9 }, global: { durationS: 60, concurrency: 1, ratePerMin: 2, credits: 2 } });
    expect(result).toEqual({ ok: true, value: { durationS: 60, concurrency: 1, ratePerMin: 2, credits: 2, egress: ["scope_target"] } });
    expect(reduceLimits({ playbook: undefined, entitlement: undefined, account: undefined, requested: undefined, global: undefined })).toEqual({ ok: false, code: "missing_authoritative_limit" });
  });
});
```

- [x] **Step 2: Implementar contratos fechados**

Defina `Plan`, `Visibility`, `Rights`, `LimitInput`, `EffectiveLimits` e `LimitResult`; aceite somente inteiros positivos, use `Math.min` apenas entre ceilings presentes e clone egress fixo como `readonly ["scope_target"]`. Nunca trate preço, saldo ou quota comercial como direito de policy.

- [x] **Step 3: Rodar GREEN e commit**

Execute `bun run test:unit -- entitlement limits` e `bun run typecheck`; esperado PASS.

```bash
git add packages/policy/src/entitlement.ts packages/policy/src/limits.ts packages/policy/src/index.ts packages/policy/test/entitlement.test.ts packages/policy/test/limits.test.ts
git commit -m "feat: add plan rights and non-escalating limits"
```

### Task 5: Implementar engine default-deny e negação DNS-TXT (T013)

**Files:**
- Create: `packages/policy/src/engine.ts`
- Create: `packages/policy/test/engine.test.ts`
- Modify: `tests/isolation/policy.test.ts`
- Modify: `packages/policy/src/index.ts`

- [x] **Step 1: Escrever RED do decision contract**

Cubra ações desconhecidas, portas/capabilities/planos/categorias desconhecidos, target forbidden, scope mismatch, limite ausente, DNS-TXT, ausência de attestation e HTTP-file válido. Afirme que todas as verificações aplicáveis aparecem em `blocked`, mas qualquer bloqueio retorna `allowed:false`, `actions:[]` e limites nulos.

```ts
import { describe, expect, it } from "vitest";
import { authorize } from "../src/engine";

describe("policy authority", () => {
  it("denies dns_txt even when the record looks valid", () => {
    const decision = authorize({ action: "active_external", targetCategory: "surface", scope: { ok: true }, entitlement: "pro", limits: { ok: true }, verification: { method: "dns_txt", status: "verified" }, attestation: { version: "terms@1" }, playbook: { key: "surface-public-posture", version: "1.0.0", actions: ["http.headers"] } });
    expect(decision.allowed).toBe(false);
    expect(decision.blocked.map((item) => item.code)).toContain("verification_method_not_allowed");
    expect(decision.actions).toEqual([]);
  });

  it("runs every applicable check and never trusts caller actions", () => {
    const decision = authorize({ action: "not-a-known-action", targetCategory: "unknown", scope: { ok: false, code: "forbidden_address" }, entitlement: "unknown", limits: { ok: false, code: "missing_authoritative_limit" }, verification: null, attestation: null, playbook: null });
    expect(decision.allowed).toBe(false);
    expect(decision.blocked.length).toBeGreaterThanOrEqual(4);
    expect(decision.actions).toEqual([]);
  });
});
```

- [x] **Step 2: Implementar decisão discriminada**

Exporte `ActionRequest`, `PolicyDecision`, `BlockCode` e `authorize`. Execute checks em ordem estável: action/category/plan vocabulary, scope, target classification, attestation, verification method/status, playbook action subset, limits e egress. O reason deve ser seguro para usuário; códigos são estáveis. Só `http_file + verified + attestation version + active external` permite e somente com ações do playbook. Faça deep-freeze do resultado antes de retornar.

- [x] **Step 3: Rodar GREEN e gate review**

Execute `bun run test:unit -- engine`, `bun run test:isolation -- policy`, `bun run typecheck`, `bun run lint`, `bun run format`, `git diff --check`. Esperado: PASS; revisão manual deve confirmar ausência de I/O e que nenhum caller fornece actions além do playbook. Faça commit:

```bash
git add packages/policy
git commit -m "feat: enforce default-deny policy decisions"
```

**Gate 1 review:** revalidar FR-004, FR-005 e FR-014, pesquisa R7/R8 e non-goals. Não avançar se policy puder retornar ação após qualquer bloqueio.

## Gate 2 — PostgreSQL 16, roles, RLS e auditoria (T014–T017)

### Task 6: Escrever testes de migração, roles e schema antes do SQL

**Execution note:** Tasks 6 and 7 are one RED/GREEN unit and MUST use the same implementer. Task 6 deliberately records the RED evidence but does not commit or enter review until Task 7 makes the schema tests green.

**Files:**
- Create: `packages/db/test/schema.integration.test.ts`
- Create: `packages/db/test/roles.isolation.test.ts`
- Create: `tests/isolation/rls.test.ts`
- Modify: `packages/db/package.json`

- [x] **Step 1: Preparar fixture PostgreSQL 16**

Os testes devem usar `DATABASE_URL` obrigatório e recusar qualquer URL cujo database não termine em `_test` quando uma operação destrutiva de fixture for solicitada. A prova normal não derruba schema: conecta como migration owner a um PostgreSQL 16 recém-criado pelo CI/Compose, roda migration uma vez e reroda. Quando `RUN_DB_TESTS` não for `1`, o teste deve usar `describe.skip` com motivo explícito; CI sempre define `RUN_DB_TESTS=1` e usa `touchmyapi_test`.

- [x] **Step 2: Escrever as asserções RED**

Verifique as 18 tabelas `account,user,session,assessment,authorization_attestation,verification,playbook,job,runner_execution,credential,finding,report,credit_entry,billing_event,entitlement,agent,audit_event,notification`; enums e `timestamptz`; `account_id` direto em cada tabela tenant-owned; FK compostas impedem referências cruzadas; rerun é idempotente.

```ts
import { describe, expect, it } from "vitest";
import { createRawDbConnection } from "../src/connection-internal";

describe.runIf(process.env.RUN_DB_TESTS === "1")("PostgreSQL 16 foundation", () => {
  it("will expose every tenant table after migration", async () => {
    const db = createRawDbConnection(process.env.DATABASE_URL!);
    const result = await db.unsafe<{ relname: string }[]>("select relname from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace order by relname");
    expect(result.map((row) => row.relname)).toEqual(expect.arrayContaining(["account", "user", "session", "assessment", "authorization_attestation", "verification", "playbook", "job", "runner_execution", "credential", "finding", "report", "credit_entry", "billing_event", "entitlement", "agent", "audit_event", "notification"]));
    await db.end();
  });
});
```

Execute `RUN_DB_TESTS=1 bun run test:integration -- schema`; esperado RED.

- [x] **Step 3: Registrar RED sem commit intermediário**

Capture a falha esperada no relatório do implementer e prossiga imediatamente para Task 7. Não faça commit com a suíte de branch quebrada; os testes entram no commit GREEN da Task 7.

### Task 7: Criar schema Drizzle completo e migration PostgreSQL 16 (T014)

**Files:**
- Create: `packages/db/schema/common.ts`
- Create: `packages/db/schema/identity.ts`
- Create: `packages/db/schema/assessment.ts`
- Create: `packages/db/schema/catalog.ts`
- Create: `packages/db/schema/execution.ts`
- Create: `packages/db/schema/billing.ts`
- Create: `packages/db/schema/audit.ts`
- Modify: `packages/db/schema/index.ts`
- Create: `packages/db/migrations/0000_foundation.sql`
- Modify: `packages/db/src/index.ts`

- [x] **Step 1: Implementar enums e helpers sem shortcuts**

Use `pgEnum` para todos os vocabulários de `data-model.md`, `timestamptz` para timestamps, `gen_random_uuid()` após `pgcrypto`, `citext` no email, `jsonb` para snapshots e `bytea` para AEAD. Cada tabela tenant-owned possui `accountId` `notNull`; `session` também o possui. `playbook` é catálogo explicitamente separado. A tabela `audit_event` aceita `account_id null` somente para system chain.

O helper comum deve ser completo e reutilizado:

```ts
import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

export const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
export const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
```

Implemente as colunas exatamente de `data-model.md` nos módulos coesos e reexporte todas pelo `index.ts`:

```ts
export * from "./common";
export * from "./identity";
export * from "./assessment";
export * from "./catalog";
export * from "./execution";
export * from "./billing";
export * from "./audit";
```

Toda tabela tenant-owned referenciável deve declarar unique `(account_id, id)`; referências entre duas entidades tenant-owned usam somente FK composta `(account_id, foreign_id) -> (account_id, id)`, impedindo vínculo cruzado. Referências a catálogo global usam FK simples. Inclua unique `(provider, provider_subject)`, `billing_event.stripe_event_id`, `job.dedupe_key` e `agent.token_hash`; não invente outras unicidades ausentes do modelo.

- [x] **Step 2: Gerar e revisar migration**

Execute `DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bunx drizzle-kit generate --config=drizzle.config.ts --name foundation`; esperado `0000_foundation.sql` e journal correspondentes, sem acesso a alvo externo. Revise SQL para garantir `CREATE EXTENSION IF NOT EXISTS pgcrypto`, `CREATE EXTENSION IF NOT EXISTS citext`, enums, tabelas e constraints. Se o generator não emitir as extensões, acrescente-as no início do arquivo gerado. Roles/policies/functions ficam na migration custom da Task 8; não substitua RLS por configuração ORM.

- [x] **Step 3: Rodar schema GREEN**

Execute `docker compose -f infra/docker/compose.yml --profile local up -d postgres`. Em volume novo, `002_test_database.sql` cria `touchmyapi_test`; em volume preexistente, consulte `docker compose -f infra/docker/compose.yml exec -T postgres psql -U touchmyapi_dev -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='touchmyapi_test'"` e, somente se não retornar `1`, execute `docker compose -f infra/docker/compose.yml exec -T postgres createdb -U touchmyapi_dev touchmyapi_test`. Rode `DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run db:migrate`, repita o mesmo comando e execute `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run test:integration -- schema`. Esperado: migration inicial e rerun 0, todas as tabelas detectadas, nenhum dado de assessment criado. Nunca derrube ou limpe o database de desenvolvimento `touchmyapi`.

- [x] **Step 4: Commitar**

```bash
git add packages/db/schema packages/db/migrations packages/db/src/index.ts packages/db/test packages/db/package.json tests/isolation/rls.test.ts
git commit -m "feat: add complete postgres foundation schema"
```

### Task 8: Adicionar roles least-privilege, RLS default-deny e auth bootstrap (T015)

**Files:**
- Modify: `packages/db/migrations/0000_foundation.sql`
- Create: `packages/db/migrations/0001_rls_roles.sql`
- Create: `packages/db/test/roles.isolation.test.ts`
- Modify: `tests/isolation/rls.test.ts`

- [x] **Step 1: Escrever RED para roles e políticas**

O teste deve consultar `pg_roles` e afirmar `api_rls`, `worker_rls`, `reporting_rls`, `auth_bootstrap` como `rolsuper=false`, `rolbypassrls=false`, `rolinherit=false`, não owners; `auth_bootstrap` sem `SELECT/INSERT/UPDATE/DELETE` direto. Para cada tabela tenant-owned, sem `app.tenant`, `SELECT`, `INSERT`, `UPDATE` e `DELETE` devem falhar ou retornar zero. `playbook` é read-only ao runtime; `audit_event` não permite update/delete.

- [x] **Step 2: Implementar SQL de roles e policies**

Crie a migration journaled com `bunx drizzle-kit generate --custom --config=drizzle.config.ts --name rls_roles` e preencha `0001_rls_roles.sql`. Ela deve ser executável por migration owner e idempotente. Use roles sem senha geridas fora do repositório:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api_rls') THEN CREATE ROLE api_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worker_rls') THEN CREATE ROLE worker_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_rls') THEN CREATE ROLE reporting_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_bootstrap') THEN CREATE ROLE auth_bootstrap NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO api_rls, worker_rls, reporting_rls, auth_bootstrap;
```

Para cada tabela tenant-owned, use `ENABLE ROW LEVEL SECURITY; FORCE ROW LEVEL SECURITY;` e policy explícita com `NULLIF(current_setting('app.tenant', true), '') IS NOT NULL`, UUID válido e igualdade a `account_id`. Gere as políticas por SQL repetido, não por wildcard implícito; o teste deve enumerar as 18 tabelas. `playbook` recebe `SELECT` somente e `audit_event` recebe insert/select sem update/delete.

As funções `SECURITY DEFINER` devem ter `SET search_path = pg_catalog, public`, owner migration, `REVOKE EXECUTE FROM PUBLIC`, e `GRANT EXECUTE` apenas em `auth_complete_google_login(text,citext,text,timestamptz,inet,text)`, `auth_resolve_session(text)`, `auth_rotate_session(text,text,timestamptz)` e `auth_revoke_session(text)` para `auth_bootstrap`. Elas aceitam somente parâmetros tipados para concluir um login Google por `provider_subject`, criar identidade/account quando necessário, persistir somente o hash da sessão e auditar tudo atomicamente; resolver um hash de sessão válida; rotacionar hash; e revogar hash. Nunca procuram por email e nunca expõem payload arbitrário.

- [x] **Step 3: Verificar RED/GREEN**

Execute `DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run db:migrate`, `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run test:isolation -- roles`; esperado PASS. Execute uma consulta como `SET ROLE api_rls; SELECT * FROM account;` sem tenant; esperado erro/zero. Confirme que não existe role Supabase service-role no SQL.

- [x] **Step 4: Commitar**

```bash
git add packages/db/migrations packages/db/test/roles.isolation.test.ts tests/isolation/rls.test.ts
git commit -m "feat: enforce least-privilege postgres rls roles"
```

### Task 9: Implementar tenant transaction wrapper e isolamento adversarial (T016)

**Files:**
- Create: `packages/db/src/tenant-session.ts`
- Create: `packages/db/test/tenant-session.integration.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `tests/isolation/rls.test.ts`

- [x] **Step 1: Escrever RED da API e vazamento de estado**

Teste dois accounts: A pode selecionar/inserir/atualizar seus rows; A não pode selecionar, inserir, atualizar, deletar, referenciar ou inferir rows B em account, session, assessment, credential, finding e audit. Depois de uma transação A, uma nova conexão borrowed sem tenant não pode herdar `app.tenant` ou role.

- [x] **Step 2: Implementar wrapper fechado (substituído pelo boundary aceito)**

Exporte exatamente:

```ts
export type RuntimeRole = "api_rls" | "worker_rls" | "reporting_rls";
export type TenantDatabase = object; // handle opaco, sem driver/raw query público
export type TenantContext<R extends RuntimeRole> = { readonly role: R; readonly account: object };
export async function withTenant<T, R extends RuntimeRole>(connection: TenantDatabase, accountId: string, role: R, callback: (context: TenantContext<R>) => Promise<T>): Promise<T>;
```

Receba o handle explicitamente; o módulo não lê `DATABASE_URL` ou `process.env`. Valide UUID, escolha role por mapa literal, abra transaction, execute `select set_config('app.tenant', $1, true)`, `set local role "api_rls"`/role literal do mapa, rode callback, commit; em qualquer erro rollback e sempre devolva conexão com `RESET ROLE`/fim de transaction. O driver raw e o executor vivem em `WeakMap` interno; callbacks usam somente métodos literal/parametrizados, sem SQL, identificador ou `account_id` fornecido pelo chamador.

- [x] **Step 3: Rodar GREEN**

Execute `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run test:integration -- tenant-session` e `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run test:isolation`; esperado PASS, inclusive contexto ausente e role inválida.

- [x] **Step 4: Commitar**

```bash
git add packages/db/src/tenant-session.ts packages/db/src/index.ts packages/db/test/tenant-session.integration.test.ts tests/isolation/rls.test.ts
git commit -m "feat: scope database transactions by tenant"
```

### Task 10: Persistir audit chain por conta e sistema (T017)

**Files:**
- Create: `packages/db/src/audit.ts`
- Create: `packages/db/test/audit.integration.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `tests/isolation/rls.test.ts`

- [ ] **Step 1: Escrever RED de redaction, atomicidade e concorrência**

Use o `auditEventSchema` existente como contrato e teste recursivamente `password`, `token`, `authorization`, `cookie`, `secret`, `privateKey`, JWT e PEM removidos antes de INSERT. Insira concorrência para a mesma conta e afirme cadeia sem dois `prev_event_id` iguais indevidos; force erro e afirme que mutation e audit rollbackam juntas; runtime não atualiza/deleta histórico. Teste também a cadeia accountless em `audit_system_state`, a ausência de acesso a dados de negócio pelo conector de sistema e a expiração de ambas as capabilities.

- [ ] **Step 2: Implementar writer transacional**

Exporte `appendAuditEvent(context, input)`. Redija payload antes de persistir, derive `account_id` somente do contexto ativo, faça `SELECT ... FROM public.account WHERE id=$1 FOR UPDATE`, selecione o último evento da cadeia dentro da mesma transação e insira o próximo. Para evento accountless, use `withSystemAudit` e bloqueie a linha singleton `audit_system_state(id='system')`; o `audit_system`/connector dedicado recebe somente RLS/grants necessários para essa cadeia. O método deve lançar erro se audit falhar; mutation crítica deve chamar ambos no mesmo callback de `withTenant`. Nenhuma superfície de advisory lock ou SQL arbitrário é permitida. Consulte `docs/superpowers/specs/2026-08-22-audit-chain-design.md`.

- [ ] **Step 3: Rodar GREEN e revisar**

Execute `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run test:integration -- audit`, `RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run test:isolation`, `bun run typecheck`, `bun run lint`, `bun run format`, `git diff --check`; esperado PASS. Commit:

```bash
git add packages/db/src/audit.ts packages/db/src/index.ts packages/db/test/audit.integration.test.ts tests/isolation/rls.test.ts
git commit -m "feat: add atomic redacted audit chains"
```

**Gate 2 review:** conferir migration vazia + rerun, roles não owner/non-inherit/non-bypass, `FORCE ROW LEVEL SECURITY`, ausência de `DATABASE_URL` default, todos os rows tenant-owned com `account_id`, bootstrap sem lookup por email, e isolamento A/B para todos os access classes.

## Gate 3 — secrets e catálogo passivo (T018–T019)

### Task 11: Implementar envelope AEAD para credenciais externas (T018)

**Files:**
- Create: `packages/secrets/package.json`
- Create: `packages/secrets/src/aead.ts`
- Create: `packages/secrets/src/index.ts`
- Create: `packages/secrets/test/aead.test.ts`

- [ ] **Step 1: Escrever RED de round-trip e negativos**

Teste nonce diferente em duas encryptions, tamper de cada campo, account/assessment/credential/purpose errado, key id ausente/errado/rotacionado e erro sem plaintext/key/stack. O provider é fake em teste, não lê env:

```ts
import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, type KeyProvider } from "../src/aead";

const provider: KeyProvider = { getKey: async (keyId) => keyId === "k1" ? new Uint8Array(32).fill(7) : undefined };
const context = { accountId: "a", assessmentId: "b", credentialId: "c", purpose: "api" };

describe("credential AEAD", () => {
  it("round-trips with unique nonce and context-bound ciphertext", async () => {
    const one = await encryptCredential(provider, "k1", "secret-value", context);
    const two = await encryptCredential(provider, "k1", "secret-value", context);
    expect(one.nonce).not.toBe(two.nonce);
    expect(await decryptCredential(provider, one, context)).toBe("secret-value");
  });

  it("rejects tamper and wrong context without revealing secret", async () => {
    const envelope = await encryptCredential(provider, "k1", "secret-value", context);
    await expect(decryptCredential(provider, { ...envelope, ciphertext: envelope.ciphertext.slice(0, -2) + "aa" }, context)).rejects.toThrow("credential decryption failed");
    await expect(decryptCredential(provider, envelope, { ...context, accountId: "other" })).rejects.toThrow("credential decryption failed");
  });
});
```

- [ ] **Step 2: Implementar envelope e contexto AAD**

Use `version: 1`, `algorithm: "AES-256-GCM"`, `keyId`, fresh 12-byte nonce, base64url ciphertext/tag e AAD canonical JSON ordenado de `accountId`, `assessmentId`, `credentialId`, `purpose`. `KeyProvider` é injetado; chaves devem ter 32 bytes; ausência de provider/key e falhas de autenticação retornam somente `Error("credential encryption failed")` ou `Error("credential decryption failed")`. O módulo não importa `process.env`, não persiste e não loga.

- [ ] **Step 3: Rodar GREEN e commit**

Execute `bun run test:unit -- aead`, `bun run typecheck`; esperado PASS.

```bash
git add packages/secrets
git commit -m "feat: add context-bound credential aead"
```

### Task 12: Validar playbook fechado e catálogo `surface-public-posture@1.0.0` (T019)

**Files:**
- Create: `packages/playbooks/package.json`
- Create: `packages/playbooks/src/index.ts`
- Create: `packages/playbooks/src/surface-public-posture.ts`
- Create: `packages/playbooks/test/playbook.test.ts`
- Modify: `packages/contracts/src/playbook.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Escrever RED do contrato e slice**

Teste parse do catálogo exato, versão, target `surface`, limites 300/1/10, egress somente `scope_target`, stop signals, severities `info/low`, ações exatamente `dns.records`, `tls.cert`, `http.headers`, `robots.txt`, `sitemap.xml`, `endpoint.minimal`; campos extra, action type desconhecido, target fora de scope e action não declarada devem falhar. Afirme que package não exporta função de execução nem chama `fetch`/DNS.

- [ ] **Step 2: Implementar schema e contrato literal**

Endureça `playbookSchema` com `.strict()` em todo objeto e vocabulário fechado. `surfacePublicPosture` deve ser uma constante `Readonly<Playbook>` validada por `playbookSchema.parse`:

```ts
export const surfacePublicPosture = playbookSchema.parse({
  schemaVersion: "playbook.schema@1",
  key: "surface-public-posture",
  version: "1.0.0",
  targetCategory: "surface",
  active: true,
  preconditions: [{ kind: "http_verification_required", when: "active_external" }],
  actions: [
    { id: "dns.records", type: "dns_lookup", allowedTargets: "scope", limit: { requests: 1, durationS: 30 } },
    { id: "tls.cert", type: "tls_probe", allowedTargets: "scope", limit: { requests: 1, durationS: 30 } },
    { id: "http.headers", type: "http_probe", allowedTargets: "scope", method: "GET", limit: { requests: 5, durationS: 30 } },
    { id: "robots.txt", type: "robots_fetch", allowedTargets: "scope", method: "GET", limit: { requests: 1, durationS: 30 } },
    { id: "sitemap.xml", type: "sitemap_fetch", allowedTargets: "scope", method: "GET", limit: { requests: 1, durationS: 30 } },
    { id: "endpoint.minimal", type: "endpoint_probe", allowedTargets: "scope", method: "GET", limit: { requests: 2, durationS: 60 } },
  ],
  limits: { maxDurationS: 300, maxConcurrency: 1, maxRatePerMin: 10, egress: { allow: ["scope_target"], blockDefaults: true }, impactLevels: ["low"] },
  stopSignals: ["scope_escape", "rate_exceeded", "unauthorized_endpoint", "duration_exceeded"],
  evidence: { expected: ["http_headers_snapshot", "tls_cert_metadata"], format: "manifest" },
  severityPossible: ["info", "low"],
});
```

`packages/playbooks/src/index.ts` deve exportar somente schema, tipo, catálogo e função pura `slicePassive`; função retorna novas estruturas e não altera limites.

- [ ] **Step 3: Rodar GREEN, contract gate e commit**

Execute `bun run test:contract`, `bun run typecheck`, `bun run lint`, `bun run format`; esperado PASS. Commit:

```bash
git add packages/playbooks packages/contracts/src/playbook.ts packages/contracts/src/index.ts
git commit -m "feat: catalog closed passive playbook"
```

**Gate 3 review:** confirmar que AEAD não possui default key/env, playbook não executa ação, desconhecidos falham, e nenhum código novo contacta target.

## Gate 4 — Hono e Google OAuth PKCE (T020–T021)

### Task 13: Criar configuração, erros, request ID e factory Hono (T020)

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/config.ts`
- Create: `apps/api/src/error.ts`
- Create: `apps/api/src/request-id.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/test/app.test.ts`

- [ ] **Step 1: Escrever RED da fronteira API**

Teste `GET /health` 200 e JSON schema atual; `GET /missing` 404 `{error:{code:"not_found",message:"Not Found"}}`; `/health` e `/api/v1/auth/*` aceitam somente o origin configurado (credenciais apenas em auth) e não enviam `access-control-allow-origin` para origin diversa; request ID em sucesso/erro; erro inesperado mapeado para 500 sem stack. Use `AuditSink` fake para provar request audit em `/api/v1`, payload redigido e mutation recusada com 503 quando o sink falha. Teste que assessment route não existe.

- [ ] **Step 2: Implementar `createApp(dependencies)`**

A factory inicial deve receber `config`, `logger` e um `AuditSink` tipados e não abrir listener; `AuditSink.record` recebe somente action, requestId e payload já redigido para toda request sob `/api/v1`. Task 14 estende as dependências com `sessionStore` e `oidc`. `server.ts` somente chama `Bun.serve`. Use Hono middleware de request ID, CORS de origin exata em `/health` e nas futuras rotas auth (`credentials` somente em auth), audit middleware centralizado, error handler estável e Zod. Falha do audit sink em mutation retorna 503; health não depende de audit. O envelope é:

```ts
export const errorEnvelope = (code: string, message: string, field?: string) => ({ error: { code, message, ...(field ? { field } : {}) } });
```

Mapeie 400/401/403/409/503/500 conforme design; 500 inclui apenas `requestId` em log e mensagem pública genérica. Preserve `/health` fora de auth e mantenha `/api/v1` sem assessment handlers.

- [ ] **Step 3: Rodar GREEN**

Execute `bun run test:unit -- app`, `bun run typecheck`, `bun run --cwd apps/web build`; esperado PASS e shell preservado.

- [ ] **Step 4: Commitar**

```bash
git add apps/api/package.json apps/api/src apps/api/test
git commit -m "feat: add dependency-injected hono api boundary"
```

### Task 14: Implementar cookie transitório criptografado, adapter OIDC e Google PKCE (T021)

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/auth/oidc-adapter.ts`
- Create: `apps/api/src/auth/transient-cookie.ts`
- Create: `apps/api/src/auth/google.ts`
- Create: `apps/api/src/session.ts`
- Create: `apps/api/test/oauth.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/db/src/auth-bootstrap.ts`
- Modify: `packages/db/migrations/0001_rls_roles.sql`

- [ ] **Step 1: Escrever RED usando fake adapter, sem Google**

Teste login redireciona com `response_type=code`, `code_challenge_method=S256`, state e nonce criptograficamente diferentes; callback rejeita state, nonce, issuer, audience, subject e redirect incorretos; sucesso cria identidade por `(google, provider_subject)` sem email linking; logout ausente/repetido é 204; `/auth/me` retorna somente user/account/plan/iaEnabled; GitHub/X retorna `unsupported_provider`. Inspecione `Set-Cookie`: `HttpOnly`, `Secure` (exceto flag local explícita), `SameSite=Lax`, `Path=/`, Max-Age curto para transitório e expiração/rotação para sessão. O fake adapter deve contar chamadas e nunca fazer rede.

```ts
const fakeOidc = {
  authorizationUrl: async (input: { state: string; nonce: string; codeChallenge: string }) => `https://accounts.example.test/auth?state=${input.state}&nonce=${input.nonce}&code_challenge=${input.codeChallenge}`,
  exchangeCode: async () => ({ issuer: "https://accounts.google.com", audience: "client", subject: "sub-1", email: "user@example.test" }),
};
```

Execute `bun run test:unit -- oauth`; esperado RED.

- [ ] **Step 2: Implementar interfaces e cookie seguro**

Adicione `openid-client` e `zod` às dependências da API. `oidc-adapter.ts` deve exportar:

```ts
export type OidcClaims = { issuer: string; audience: string; subject: string; email: string };
export interface OidcAdapter {
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): Promise<string>;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; nonce: string }): Promise<OidcClaims>;
}
export function createGoogleOidcAdapter(config: { clientId: string; clientSecret: string; redirectUri: string }): OidcAdapter;
```

O adapter real usa Authorization Code + PKCE S256 de `openid-client`, issuer `https://accounts.google.com`, audience/client ID e redirect URI exatos; não é usado nos testes. `transient-cookie.ts` usa chave obrigatória injetada e AES-GCM para `{state,nonce,codeVerifier,returnTo,expiresAt}`, cookie HttpOnly/Secure/SameSite=Lax, erro genérico e limpeza em qualquer callback OAuth. Não use a chave de cookie como client secret.

- [ ] **Step 3: Implementar sessão opaca e bootstrap estreito**

`session.ts` gera 32 bytes random, envia token somente no cookie, calcula SHA-256 e persiste apenas hash. Resolve por hash, verifica expiração/revogação, roda rotação atômica e revoga por `auth_bootstrap`. A migration deve usar `auth_complete_google_login(provider_subject,email,session_hash,expires_at,ip,user_agent)` para criação de account/user/session/audit em uma transação; as outras funções resolvem, rotacionam ou revogam exclusivamente por hash. Ausência de Stripe entitlement resulta em `free_unverified` derivado em memória; login não insere entitlement/credit. Email nunca é chave de busca ou vínculo.

- [ ] **Step 4: Integrar rotas e falhas seguras**

Implemente `GET /api/v1/auth/login`, `GET /api/v1/auth/callback`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`. Limpe cookie transitório em erro e não inclua code, token, claims, verifier, state, nonce ou body provider em resposta/log/audit. Rejeite produção sem `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, redirect URI ou cookie key com 503 de configuração; aceite cookie inseguro somente com `ALLOW_INSECURE_COOKIES=true` e `NODE_ENV=development`.

- [ ] **Step 5: Rodar GREEN e security gate**

Execute `bun run test:unit -- oauth`, `bun run test:contract`, `bun run typecheck`, `bun run lint`, `bun run format`, `git diff --check`; esperado PASS. Execute `rg -n "fetch\\(|Bun\\.serve|accounts.google.com" apps/api/test packages` para confirmar que apenas adapter real contém endpoint e os testes usam fake; nenhum teste pode sair para internet.

```bash
git add apps/api packages/db/src/auth-bootstrap.ts packages/db/migrations/0001_rls_roles.sql
git commit -m "feat: add testable google pkce sessions"
```

**Gate 4 review:** confirmar OAuth Google-only, PKCE/state/nonce/issuer/audience, identidade imutável, sem email-linking, hash-only session, revogação/rotação, CORS exato, erros safe e ausência de assessment/target routes.

## Gate 5 — revisão final, prova da spec e handoff

### Task 15: Revisar contra design/spec e fechar qualidade

**Files:**
- Modify: `specs/001-touchmyapi-platform/quickstart.md`
- Modify: `README.md`
- Modify: `specs/001-touchmyapi-platform/tasks.md`
- Create: `docs/reviews/2026-08-22-foundation-phase2-implementation.md`

- [ ] **Step 1: Rodar a sequência final obrigatória**

Execute no worktree com PostgreSQL 16:

```bash
bun install --frozen-lockfile
bun run verify:workspace
bun run test:unit
bun run test:contract
RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run test:integration
RUN_DB_TESTS=1 DATABASE_URL=postgres://touchmyapi_dev:touchmyapi_dev@127.0.0.1:5433/touchmyapi_test bun run test:isolation
bun run test:e2e
bun run typecheck
bun run lint
bun run format
bun run --cwd apps/web build
docker compose -f infra/docker/compose.yml config
git diff --check
```

Esperado: todos exit 0; integração/isolation nunca são contabilizadas como passadas quando skipadas; e2e aparece como pending/skipped de forma explícita. Registre no review comando, versão Bun 1.4.0, PostgreSQL 16, resultado e qualquer bloqueio externo sem marcar como verde.

- [ ] **Step 2: Fazer revisão de cobertura por requisito**

No documento de review, marque evidência para T010–T021, FR-001–FR-005, FR-014, FR-018 e SC-002/SC-003/SC-007, além das decisões R1/R2/R5/R7/R8. Confirme que os non-goals não foram violados e que nenhum novo arquivo contém execução, rede de target, Stripe mutation, AI tool, relatório ou runner. Inclua a matriz de teste: unit policy/AEAD, contract playbook/API, integration migration/auth/audit, isolation A/B/RLS, e2e pending.

- [ ] **Step 3: Corrigir drift documental e atualizar status**

Atualize quickstart/README apenas para descrever o que realmente está executável: health, policy, migrations/RLS, AEAD, catálogo passivo e auth fakeável; não anuncie assessment. Em `tasks.md`, marque T010–T021 somente com evidência dos testes verdes e deixe tarefas posteriores sem alteração de status.

- [ ] **Step 4: Commitar documentação e revisão**

```bash
git add README.md specs/001-touchmyapi-platform/quickstart.md specs/001-touchmyapi-platform/tasks.md docs/reviews/2026-08-22-foundation-phase2-implementation.md
git commit -m "docs: record foundation phase two verification"
```

### Checklist de qualidade antes de declarar a fase concluída

- [ ] `packages/policy` não possui efeitos colaterais e nenhuma decisão permitida após bloqueio.
- [ ] `dns_txt` continua enum reservado, mas nunca autoriza.
- [ ] PostgreSQL 16 migra de vazio e reroda; roles runtime são não-owner, non-superuser, non-inherit, non-BYPASSRLS.
- [ ] Toda tabela tenant-owned tem `account_id`, policy `current_setting('app.tenant', true)`, `ENABLE/FORCE RLS` e teste A/B.
- [ ] Bootstrap OAuth não possui acesso arbitrário a tabelas nem lookup por email.
- [ ] Audit é redigido antes do INSERT, encadeado por advisory lock e falha fechado em mutation crítica.
- [ ] AEAD exige key provider e AAD completo; erros não revelam plaintext/key.
- [ ] Playbook é versão `surface-public-posture@1.0.0`, ações fechadas, passivo e sem executor.
- [ ] API factory preserva health/404, CORS exato, request ID e envelope seguro.
- [ ] OAuth é testado por adapter fake, usa PKCE S256/state/nonce, cookie transitório criptografado e sessão hash-only.
- [ ] A sequência final obrigatória passa e `git diff --check` não reporta erro.

Plan complete and saved to `docs/superpowers/plans/2026-08-22-foundation-phase2.md`. The user selected autonomous Subagent-Driven execution: dispatch a fresh Luna high implementer per task (Tasks 6+7 are one RED/GREEN unit), then perform spec-compliance review followed by code-quality review before advancing.
