# TouchMyAPI — especificação de produto e arquitetura v0.1

**Status:** proposta base para validação antes do scaffold
**Data:** 17 de agosto de 2026
**Público inicial:** pessoa física no Brasil, com plano gratuito, compra avulsa, Pro e Enterprise sob proposta.

**Nota de supersessão:** a decisão histórica de conta individual permanece válida para a fundação de 17 de agosto. A extensão aprovada de 22 de agosto adiciona, somente após T021, `account` como workspace/tenant, memberships explícitos, fila PostgreSQL cercada por fencing/outbox e plano administrativo separado; consulte `docs/superpowers/specs/2026-08-22-multiuser-queue-admin-design.md`. SSO e SCIM continuam fora do escopo.

## 1. O produto

TouchMyAPI é uma plataforma de assessments de segurança autorizados. Ela recebe um alvo e um escopo, verifica a autorização quando há teste ativo, executa playbooks com limites, valida evidências e entrega uma visão operacional e relatórios técnicos.

O produto não é um scanner irrestrito, uma shell remota nem um "agente que tenta tudo". Toda execução deve ser atribuível a um usuário, um alvo, um escopo e uma política de execução.

### 1.1 Resultado para o cliente

1. Entrar com Google.
2. Criar um assessment em um modal guiado.
3. Acompanhar a fila e a execução pela lista de assessments.
4. Receber uma notificação dentro do produto ao finalizar.
5. Consultar findings e baixar relatórios, conforme o plano.

O usuário não vê filas, workers, modelos, containers ou credenciais. Esses componentes existem para segurança e confiabilidade, não como complexidade de interface.

### 1.2 Escopo de alvos na primeira versão

- Aplicação web externa.
- API HTTP/GraphQL/gRPC exposta.
- Superfície externa: domínio, DNS, TLS, hosts e serviços autorizados.
- Aplicação GenAI: LLM, RAG, copilots e agentes com ferramentas.
- Ambiente interno, exclusivamente por agente privado instalado e controlado pelo cliente.

Cada categoria é implementada por playbooks versionados. Exibir uma categoria na interface não autoriza uma ferramenta arbitrária nem uma exploração fora do contrato daquele playbook.

## 2. Decisões confirmadas

| Tema | Decisão |
| --- | --- |
| Stack principal | Bun + Vite + PostgreSQL |
| Conta inicial | Individual, sem organizações, convites ou papéis no MVP |
| Login de lançamento | Apenas OAuth Google; GitHub e X ficam modelados, mas desligados |
| Identidade | `provider + provider_subject` imutável; contas só são vinculadas explicitamente, nunca por e-mail automático |
| Modalidade | Self-service automatizado, com playbooks curados e autorização obrigatória para testes ativos |
| Plano gratuito | Sem verificação: somente postura pública passiva e agregada; verificado: sumário mascarado, sem evidências ou reprodução |
| Pago | Compra avulsa, Pro recorrente e Enterprise sob proposta; créditos consumidos por tipo/tamanho de alvo, nunca por quantidade de falhas |
| Verificação externa | Arquivo HTTP no domínio alvo, antes de teste ativo |
| Credenciais | Externas: criptografadas no servidor, injetadas somente no runner por job; internas: só no agente privado do cliente |
| Relatórios | Dashboard, PDF técnico e PDF executivo; JSON em planos pagos/Enterprise; comparação entre execuções posteriores |
| Notificações | Apenas dentro da plataforma no lançamento |
| Integrações | Slack, Teams, webhooks e similares aparecem como placeholders, sem integração funcional |
| Cobrança | Stripe Checkout hospedado; Pix/cartão em compra avulsa; cartão para Pro recorrente; webhooks confirmam toda alteração financeira |
| Mercado inicial | Brasil, BRL |

O modelo de dados terá `account_id` internamente desde o início, embora a interface trate cada conta como individual. Isso evita uma migração destrutiva quando organizações forem adicionadas.

## 3. Planos e direitos

### 3.1 Free não verificado

Permite apenas observação pública e de baixo impacto: DNS, certificado/TLS, cabeçalhos HTTP, tecnologias aparentes, `robots.txt`, `sitemap.xml` e uma coleta mínima de endpoints públicos. Não permite autenticação, payloads, exploração, brute force, fuzzing, crawling amplo ou validação ativa.

O resultado é um retrato agregado de postura. Não apresenta caminhos de exploração.

### 3.2 Free verificado

Após a verificação HTTP e a declaração de autorização, o usuário pode executar uma avaliação introdória dentro de quotas pequenas. O dashboard mostra título, categoria e severidade de achados. Endpoint, evidência, passos de reprodução, impacto detalhado e remediação permanecem bloqueados.

### 3.3 Compra avulsa e Pro

Liberam evidência, reprodução segura, impacto, recomendação, PDF técnico, PDF executivo e JSON. Pro também inclui agendamento recorrente e histórico comparável. A frequência mínima é semanal, há janela de execução configurável e somente uma execução ativa por alvo/conta.

Os valores, quotas exatas, preços e matriz de créditos são configurações de catálogo no servidor, não constantes no frontend. Enterprise começa como fluxo comercial manual.

## 4. Jornada e estados

### 4.1 Novo assessment

O modal de criação deve seguir esta ordem:

1. Escolher categoria de alvo.
2. Informar URL/domínio, especificação de API ou conexão com agente privado.
3. Delimitar inclusões, exclusões, janela, contatos e credenciais de teste quando aplicável.
4. Mostrar o playbook, o consumo estimado de créditos e os limites de impacto.
5. Exigir declaração versionada de que o usuário controla ou tem autorização para testar o escopo.
6. Solicitar/confirmar a verificação HTTP para qualquer execução ativa externa.
7. Enviar a solicitação.

Credenciais nunca retornam à tela após gravadas. O modal apenas indica que existem e permite substituir ou apagar.

### 4.2 Máquina de estados

```text
draft
  -> awaiting_verification
  -> queued
  -> running
  -> analyzing
  -> completed
  -> failed | cancelled
```

`awaiting_verification` é dispensado somente para postura pública passiva do Free. Toda transição é validada no backend, é idempotente e gera evento de auditoria. Cancelamento impede a próxima etapa; um runner já em atividade recebe sinal de parada e passa por limpeza obrigatória.

### 4.3 Relatórios

- Dashboard: status, escopo, resumo, findings permitidos pelo plano, linha do tempo e créditos.
- PDF técnico: metodologia, escopo, limitações, evidência redigida, severidade, impacto, correção e apêndice de achados.
- PDF executivo: risco, prioridades, tendência e plano de ação curto.
- JSON: contrato versionado, sem segredos, disponível somente onde a permissão permitir.

O relatório declara claramente testes não executados, limitações do escopo e quando uma conclusão é inferência, não fato validado.

## 5. Arquitetura proposta

```text
Vite web
  -> API Bun (sessão, domínio, autorização, billing, relatórios)
       -> PostgreSQL (fonte de verdade + fila durável)
       -> Control worker (política, scheduler, despacho)
       -> Runner isolado (playbook permitido, artefatos, limpeza)
       -> Object storage privado (evidência e PDFs)
       -> Stripe (Checkout + webhook)
       -> DeepSeek (planejamento/triagem estruturado e sanitizado)
       -> Codex (redação a partir de findings validados e redigidos)

Agente privado do cliente
  -> canal autenticado para o control worker
  -> runner local isolado para alvos internos
```

Estrutura inicial do monorepo:

```text
apps/
  web/                 # Vite: apenas UI e chaves públicas
  api/                 # Bun: domínio, sessões, cobrança e relatórios
  worker-control/      # scheduler, política e despacho
packages/
  db/                  # schema, migrações e acesso sob RLS
  contracts/           # schemas de API, eventos e JSON exportável
  policy/              # escopo, direitos, bloqueios e limites
  playbooks/           # contratos e versões dos playbooks
  reporting/           # composição de PDFs e sanitização
  ui/                  # componentes compartilhados
```

Na V1, o runner pode ser um container efêmero isolado. O contrato deve ser implementado atrás de `SandboxProvider`, permitindo migrar futuramente a sandboxes persistentes/gerenciados sem trocar o domínio do produto. Não entram agora CRDs, warm pools ou Kubernetes como requisito de lançamento.

## 6. Segurança por design

### 6.1 Frontend, API e dados

- O Vite nunca recebe chave secreta, entitlement, segredo de OAuth, chave Stripe privada, credencial de alvo ou autorização de runner. Tudo que começa com `VITE_` é público por definição.
- Sessões são HttpOnly, Secure, SameSite adequado, rotacionadas e revogáveis; OAuth usa Authorization Code com PKCE, `state`, nonce e redirect URIs exatas.
- Dados usam `account_id` e Row-Level Security no PostgreSQL, com roles de runtime que não sejam owner nem tenham bypass de RLS. A política é default deny e possui testes de isolamento entre contas.
- API valida schema, ownership, estado e entitlement em todas as mutações. IDs não concedem acesso.
- Arquivos e relatórios ficam em object storage privado, com URL temporária por usuário autorizado, sem bucket público.

### 6.2 Escopo e autorização

Um assessment ativo exige: alvo normalizado, escopo explícito, exclusões, playbook, limites, verificação HTTP e atestado de autorização versionado. O atestado guarda usuário, conta, alvo, data, versão dos termos e escopo submetido.

O motor de políticas é a autoridade final. Ele bloqueia alvos fora do escopo, endpoints locais/metadata/redes privadas em testes externos, redirecionamentos para IPs proibidos, portas/comandos não permitidos, excesso de taxa, duração, concorrência e créditos. O browser, o modelo e o runner não podem aumentar esses limites.

### 6.3 Runner

- Job assinado, com TTL, capacidades mínimas e uma lista fechada de ações.
- Imagem imutável por digest, usuário não-root, filesystem de trabalho temporário, CPU/memória/duração limitadas e rede com egress controlado.
- Sem socket Docker, sem acesso ao banco principal e sem shell genérica exposta ao usuário ou ao modelo.
- Credenciais são entregues por canal de segredo de uso curto e removidas ao encerrar; não vão para variáveis persistentes, logs, relatórios ou modelos.
- Saída é limitada, redigida e enviada como manifesto de artefatos com hashes e proveniência.

### 6.4 Playbooks e validação

Cada playbook declara versão, pré-condições, categoria de alvo, ações permitidas, limite de requisições, duração máxima, sinais de parada, evidência esperada e severidade possível. Ele segue a sequência: escopo, descoberta, hipótese, validação focada, controle negativo, evidência e relatório.

Payloads perigosos, indisponibilidade, exfiltração, persistência, brute force e exploração invasiva não entram em execução padrão. Qualquer extensão futura precisa de uma categoria explícita, consentimento e política própria.

### 6.5 IA e agentes

DeepSeek é planejador/triador, não executor de rede ou shell. Ele devolve um plano estruturado; o motor de políticas o reduz ou rejeita antes de criar um job. Codex recebe somente findings validados, metadados permitidos e evidências redigidas para estruturar relatório; ele não recebe credenciais nem controla ferramentas de ataque.

Conteúdo do alvo, descrições, páginas, RAG e respostas de modelos são tratados como não confiáveis. Instruções presentes nesses dados não podem alterar ferramentas, escopo, memória, acesso a segredos ou política. Dados privados brutos não são enviados a provedores externos de IA. O uso de IA externa é registrado por assessment e deve poder ser desativado para o cliente/conta em fase posterior.

Esse desenho aplica separação de identidade, least privilege, policy enforcement, human-in-the-loop e proteção contra prompt injection, abuso de ferramentas, envenenamento e vazamento — temas centrais dos documentos GenAI/Agentic/OWASP 2026 fornecidos como base.

## 7. Agente privado para ambiente interno

O agente privado é instalado pelo cliente e possui uma identidade própria, revogável e limitada ao ambiente/conta. Ele abre uma conexão de saída autenticada ao control worker; a internet não abre conexão para dentro da rede do cliente.

Credenciais internas ficam somente nesse agente. O servidor manda uma especificação de job assinada, limitada e expirada; o agente executa localmente, devolve artefatos permitidos e nunca envia segredo. O onboarding exibirá token único, fingerprint, status, última atividade e revogação. A primeira versão não oferece acesso interativo ao host.

## 8. Cobrança e entitlement

Stripe Checkout hospedado atende compra avulsa via Pix ou cartão e Pro via assinatura em cartão. O navegador apenas inicia a intenção de compra; a API cria o pedido interno e associa `account_id`, produto, preço, moeda e referência. O webhook Stripe, verificado por assinatura e processado de forma idempotente, é o único fato que altera pagamento, créditos ou acesso.

O webhook é guardado com ID externo, payload mínimo necessário, assinatura validada, versão do evento e resultado de processamento. Reentregas não duplicam créditos. Cancelamentos, chargebacks, falhas de pagamento e expiração revogam direitos conforme regras do catálogo, nunca por lógica no cliente.

## 9. Dados, auditoria e retenção inicial

| Informação | Regra inicial |
| --- | --- |
| Evidência bruta de runner | 30 dias após término, com eliminação programada |
| Findings e relatórios | 365 dias para planos pagos; Free conforme quota curta de produto |
| Logs de execução | 30 dias, redigidos e limitados |
| Auditoria de segurança e autorização | 365 dias, append-only no nível da aplicação |
| Credencial externa | até o término do job; apagada após uso salvo se o usuário a guardar explicitamente para agenda futura |
| Credencial interna | nunca armazenada na plataforma |

Apagar uma conta cancela agendas, revoga agentes/tokens, solicita revogação de sessão e inicia eliminação de dados conforme retenções operacionais e obrigações legais. A versão inicial deve oferecer exportação e exclusão por solicitação; a política pública detalhada entra antes do lançamento.

## 10. Operação e confiabilidade

PostgreSQL é a fonte de verdade de estados e da fila durável no começo. A implementação de fila deve oferecer lock/lease, retry com backoff, deduplicação, cancelamento, timeout e recuperação de job abandonado. Redis, Kafka e Kubernetes não são pré-requisitos iniciais.

Há uma execução simultânea por alvo/conta e limites globais conservadores. Métricas mínimas: profundidade da fila, idade do job, taxa de falha por playbook, duração, cancelamentos, uso de créditos, bloqueios de política, falhas de webhook e tentativas de acesso entre contas. Alertas internos não são integrações de cliente.

O sistema registra um trilho de auditoria encadeado: solicitação, autorização, verificação, decisão de política, despacho, runner, artefatos, análise, publicação, download e billing.

## 11. Fora da primeira versão

- Organizações, convites, RBAC visível, SSO e SCIM.
- Login por GitHub ou X.
- Slack, Teams, e-mail, browser push e webhooks de cliente.
- Integrações com issue trackers, CI/CD e SIEM.
- Shell remota, shell genérica no runner ou assistente interativo ofensivo.
- Criação automática de exploits, carga destrutiva ou execução sem autorização.
- Kubernetes, CRDs e warm pools como dependência operacional obrigatória.
- Marketplace de playbooks ou execução de playbook fornecido pelo cliente.

## 12. Critérios de aceite da primeira entrega

1. Só é possível autenticar com Google e nenhuma chave sensível é entregue ao browser.
2. Um usuário não acessa dados, PDFs, créditos, credenciais ou jobs de outra conta.
3. Teste ativo externo não inicia sem verificação HTTP, escopo e atestado válidos.
4. Free não verificado não dispara teste ativo; Free verificado não revela detalhes bloqueados.
5. Um job completa, falha ou cancela sem ficar preso, e sempre preserva motivo/auditoria.
6. Runner não executa ação fora do job assinado e elimina material temporário ao final.
7. Credenciais internas nunca chegam ao servidor; externas nunca chegam ao frontend, logs, relatórios ou modelos.
8. Stripe só concede/revoga entitlement por webhook validado e idempotente.
9. Usuário vê status, resultado permitido e PDFs; JSON respeita o plano.
10. IA não obtém acesso direto a ferramentas, credenciais, rede arbitrária ou dados brutos privados.

## 13. Próxima etapa após validação

1. Transformar esta spec em plano de implementação fatiado e testável.
2. Criar scaffold Bun/Vite/PostgreSQL e contratos de domínio, sem construir scanners antes do motor de política.
3. Implementar primeiro autenticação, isolamento de dados, estados, fila e visualização; depois Stripe e um playbook passivo controlado.
4. Acrescentar verificação HTTP, execução ativa limitada, relatórios e o agente privado em incrementos separados.
