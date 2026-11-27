# Etapa 10.4 — erros HTTP, privacidade e cache (R09/R11)

Base: backend `a17494c91fcab7f215dafe6f96bd919e210dfa45` (PR #19 integrada). Escopo exclusivamente backend; sem migrations, dependências novas, alteração de limites, sessões, CSRF ou regras de reserva. Correção proposta para revisão; não houve merge/deploy nem declaração de prontidão geral para produção.

## Diagnóstico reproduzido antes da correção

Em cópia descartável da base, SQLite `:memory:`, clientes sintéticos e falha SQL real com binding sentinela:

| Caso | Antes | Depois |
| --- | --- | --- |
| Exceção SQL 500, Accept HTML | HTML de debug no ambiente test, binding no corpo/log | JSON genérico; sem SQL/binding no corpo, headers ou log |
| Exceção SQL 500, Accept JSON | JSON de debug, binding no corpo/log | Mesmo JSON genérico |
| API 404 | Negociação HTML/JSON | JSON 404, sem refletir URL/query |
| Validação do login, Accept HTML | 302, caminho de flash/redirect do Vine | 422 JSON com `errors`, sem redirect |
| Validação do login, Accept JSON | 422 JSON | Mesmo envelope de validação |
| Visitante em me | 401 JSON, sem política de cache | Mesmo status/contrato, `no-store` |
| Login sem papel administrativo | 403 JSON, sem política de cache | Mesmo status/contrato, `no-store` |
| CSRF ausente | 403 JSON, sem política de cache | Código/mensagem preservados, `no-store` |
| Login/me/clientes autenticados | 200 sem política de cache | 200 `no-store` |
| Serviços administrativos | 200 `no-store` no controller | Política preservada e garantida antes do controller |

A exposição de debug foi reproduzida em test, sem alegar que debug estava habilitado em produção. A auditoria histórica contém a prova anterior de produção. A validação posterior também executou o build em modo production: API 500 JSON, sem sentinela nos logs/headers, e páginas Inertia 404/500 funcionando fora da API.

`ExceptionHandler.report()` original entregava o erro bruto ao logger e interpolava `error.message`. O erro SQLite/Knex inclui bindings nessa mensagem; redigir só o objeto `err` não bastaria. O controller de disponibilidade também registrava o erro bruto. Além disso, o identificador recebido em `X-Request-Id` entrava no logger filho e na resposta HTTP.

## Contrato final da API

O handler identifica o namespace `/api` com fronteira de segmento (inclui caminhos desconhecidos), independentemente de Accept. Validações Vine são tratadas diretamente para evitar negociação HTML/flash. Erros HTTP conhecidos mantêm status e recebem código/mensagem fixos; falhas inesperadas 500 usam:

```json
{"code":"INTERNAL_SERVER_ERROR","message":"Não foi possível processar a solicitação."}
```

Erros de negócio já retornados pelos controllers não são substituídos: 201, 409, 422, 429 e `Retry-After`, 503; `BOOKING_DATE_OUT_OF_RANGE`, `PUBLIC_BOOKING_NOT_ACCEPTED` e `E_BAD_CSRF_TOKEN` permanecem válidos. O 500 inesperado de criação/cancelamento/listagem de reservas também adota o contrato acima. Nenhuma mudança do frontend é necessária: seus tratamentos usam status e mensagens genéricas; os 44 E2E reais verificam a integração.

O middleware Inertia ignora apenas a API: um `X-Inertia-Version` arbitrário não pode converter JSON em resposta 409 de atualização de assets. Inicialização, props, flash, redirects e dispose das páginas fora da API permanecem no caminho original. As páginas de produção `/`, `/login`, 404 e 500 foram renderizadas no Chrome sem erros de página. Uma rota de falha foi instrumentada **somente no build descartável**, nunca no código versionado.

## Logging seguro

`safe_http_logging.ts` registra uma lista positiva: evento fixo, categoria, código exato conhecido, status válido da exceção, método permitido, **template** da rota ou `unmatched`, UUID do servidor. Mensagem fixa: `HTTP request failed`. Não registra mensagem/stack/cause, SQL, bindings, parâmetros de URL, corpos, autenticação, sessão ou headers. Falhas SQLite continuam identificáveis por `SQLITE_ERROR`, `SQLITE_BUSY`, constraints etc.; códigos desconhecidos viram `UNEXPECTED_ERROR`. O status no evento é o da exceção (ou 500), podendo diferir do 503 de contingência enviado pelo controller.

`report()` não delega ao reporter bruto nem executa `error.report()` de terceiros. Os três controllers que tratam falhas inesperadas usam o mesmo logger seguro. No logger configurado, serializers de `err`/`error` e redaction de campos sensíveis são defesa adicional para caminhos internos do framework. Bindings raiz limitam-se ao PID. **Pino redefine o formatter em `child()`**; por isso o binding `request_id` do Adonis é removido explicitamente por redaction, em vez de confiar no formatter para filhos. Na API, o middleware substitui o header de correlação antes da resposta; o UUID da resposta é o mesmo do evento.

Os testes capturam a saída efetiva do LoggerFactory com a configuração real (serializers, bindings e redaction habilitados), incluindo logger filho com identificador hostil. A falha ocorre em uma consulta SQLite real; antes de propagá-la o teste comprova que a mensagem bruta contém todos os marcadores sintéticos: telefone, email, token, cookie, binding e senha. As respostas 500/503 e os logs devem removê-los sem eliminar o evento diagnóstico. Há também regressões unitárias de serialização defensiva e códigos não permitidos.

Limites: não é um detector universal de dados pessoais em strings arbitrárias. Novos logs devem continuar usando mensagens fixas e campos permitidos; não interpolar entrada do usuário. Novos reporters/transportes, instrumentação de SQL, serviços externos e logs de proxy exigem revisão própria. Menos detalhes de stack/SQL nos logs de produção é uma escolha deliberada; diagnóstico detalhado deve ser reproduzido com dados sintéticos. Falhas catastróficas anteriores à criação do contexto HTTP também pertencem à configuração operacional.

## Política de não armazenamento

`ApiResponsePolicyMiddleware` é middleware de servidor, após bindings e antes de static/CORS/Vite/Inertia, body parser, sessão, Shield e autorização. Aplica a política antes de `next()` e no `finally`; o handler reaplica ao responder exceções. Assim cobre erros anteriores aos controllers, sem mudar o encadeamento de sessão/CSRF/rate limiting.

Cobertura:

- Todo `/api/admin` e seus descendentes, inclusive login/logout, me, serviços, reservas, configurações e exceções.
- GET/HEAD `/api/customers`.
- Bootstrap `/api/csrf`.
- Páginas legadas `/login`, `/logout`, `/dashboard` e raiz autenticada (esta última verificada após autenticação).
- Exceções da API recebem `no-store`, inclusive 404/422/500.

O helper remove `Expires`, `Surrogate-Control` e `CDN-Cache-Control` contraditórios e define `Cache-Control: no-store`. **Mantém ETag de calendário**: o frontend precisa dele para `If-Match`; ETag não autoriza armazenamento diante de no-store. Respostas públicas bem-sucedidas conservam a política existente. Assets não correspondem à seleção de rotas privadas: o CSS compilado foi servido 200 com `public, max-age=0`, sem receber no-store.

Um intermediário HTTP local descartável foi exercitado com consultas autenticadas/anônimas/autenticadas, sem reutilização de resposta privada. É um teste de política HTTP simples, **não uma validação de CDN, proxy ou cache real de produção**. A borda deve respeitar no-store e remover caches privados preexistentes conforme seu runbook. Não há remoção retroativa de cópias já armazenadas.

## Verificações e reprodução segura

Na cópia descartável, usar ambiente sintético com `NODE_ENV=test`, `SESSION_DRIVER=memory`, `HOST=127.0.0.1`, `PORT=0`, chave fictícia válida, origens de loopback e `TMPDIR=/dev/shm` quando disponível. Não copiar `.env`, `tmp`, build ou SQLite do workspace original. O bootstrap exige `:memory:` antes de migrar.

```sh
npm run typecheck
npm test
npm run lint
npm run build
npm run typecheck
```

Resultado: **326 testes aprovados: 132 unitários e 194 funcionais**, sem falhas; ambos typechecks sem diagnósticos, lint/build aprovados. São 13 regressões novas (2 unitárias e 11 funcionais); três expectativas de 500 anteriores foram atualizadas para o contrato genérico, sem reduzir suas verificações. A suíte anterior de sessão/CSRF, disponibilidade sem estado, quotas, horizonte, concorrência e precondições de calendário continua passando.

No frontend atual, o runner existente recebe `E2E_BACKEND_PATH` apontando para o worktree desta correção, `E2E_BROWSER_CHANNEL=chrome` e `TMPDIR=/dev/shm`; executa `npm run test:e2e` com bancos/servidores descartáveis. Resultado: **44 E2E reais aprovados**, desktop e mobile. Nenhum teste usou APIs simuladas, aumentou timeout ou modificou o frontend.

Smoke adicional do build production em HTTP loopback e Chrome: raiz/login/404/500 Inertia; API 500 com Accept HTML/JSON e request-id hostil; API 404 JSON; logs sem sentinela; CSS compilado sem regressão de cache. Screenshots e logs sintéticos locais são artefatos descartáveis, não entram no commit.

Arquivos originais de ambiente, SQLite, lockfiles e shim não rastreado foram conferidos por SHA-256, junto de status/HEAD dos dois workspaces. Só a main do backend avançou por fast-forward autorizado e uma nova branch/worktree foi criada. Branches antigas foram preservadas. R01/R02 e demais pendências operacionais da auditoria não são resolvidas por esta etapa.
