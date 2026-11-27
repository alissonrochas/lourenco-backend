# R08 — correção TypeScript da integração Inertia

Data: 27/11/2026. Base: backend main `3f12a9de9db224f620e1308ed2e1297b3499edaf`. Implementação em `fix/inertia-typescript-r08`, num worktree isolado; o workspace original sujo foi preservado. O frontend não foi modificado. A main do frontend `9c9d93660323cfd48cb53e386f544c9513e68f6a` tem a mesma árvore que o checkout `ab9742edcb3960e75a08d95012e1964736362ec0` utilizado pelo harness.

## Diagnóstico anterior à alteração

Comando oficial, preservado sem mudanças:

```sh
npm run typecheck
# tsc --noEmit && tsc --noEmit --project inertia/tsconfig.json
```

Exit original: **2**, oito diagnósticos. Reproduzido primeiro numa cópia do workspace original e depois no checkout limpo da main, sem `.env`, banco original ou `types/better_sqlite3.d.ts` local. O primeiro tsc do backend já passava; os erros estavam na segunda verificação explícita do cliente Inertia.

| Arquivo e posição originais | Código | Problema |
| --- | --- | --- |
| inertia/layouts/marketing.tsx:26:23 | TS2322 | Rota new_account.create ausente do contrato real |
| inertia/pages/auth/signup.tsx:10:13 | TS2769 | Nenhuma sobrecarga de Form aceita new_account.store |
| inertia/pages/auth/signup.tsx:24:38 | TS2339 | errors.fullName ausente do corpo inferido |
| inertia/pages/auth/signup.tsx:26:23 | TS2339 | errors.fullName ausente do corpo inferido |
| inertia/pages/auth/signup.tsx:26:74 | TS2339 | errors.fullName ausente do corpo inferido |
| inertia/pages/auth/signup.tsx:72:38 | TS2339 | errors.passwordConfirmation ausente do corpo inferido |
| inertia/pages/auth/signup.tsx:74:23 | TS2339 | errors.passwordConfirmation ausente do corpo inferido |
| inertia/pages/auth/signup.tsx:75:56 | TS2339 | errors.passwordConfirmation ausente do corpo inferido |

### Saída original completa do compilador

```text
> backend@0.0.0 typecheck
> tsc --noEmit && tsc --noEmit --project inertia/tsconfig.json

inertia/layouts/marketing.tsx(26,23): error TS2322: Type '"new_account.create"' is not assignable to type '"dashboard" | "home" | "customers.store" | "customers.index" | "admin_auth.login" | "admin_auth.logout" | "admin_auth.me" | "session.create" | "session.store" | "session.destroy" | undefined'.
inertia/pages/auth/signup.tsx(10,13): error TS2769: No overload matches this call.
  Overload 1 of 3, '(props: Omit<InertiaFormProps<{} | { email: string; password: string; }>, "children" | "method" | "action"> & { route: "dashboard" | "home" | "customers.store" | ... 6 more ... | "session.destroy"; qs?: Record<...> | undefined; method?: RouteMethod<...> | undefined; } & { ...; } & { ...; } & { ...; }): Element', gave the following error.
    Type '"new_account.store"' is not assignable to type '"dashboard" | "home" | "customers.store" | "customers.index" | "admin_auth.login" | "admin_auth.logout" | "admin_auth.me" | "session.create" | "session.store" | "session.destroy"'.
  Overload 2 of 3, '(props: Omit<InertiaFormProps<Record<string, any>>, "route" | "children"> & { route?: undefined; routeParams?: undefined; qs?: undefined; children?: FormChildren<...>; } & { ...; }): Element', gave the following error.
    Type 'string' is not assignable to type 'undefined'.
  Overload 3 of 3, '(props: (Omit<InertiaFormProps<{} | { email: string; password: string; }>, "children" | "method" | "action"> & { route: "dashboard" | "home" | "customers.store" | ... 6 more ... | "session.destroy"; qs?: Record<...> | undefined; method?: RouteMethod<...> | undefined; } & { ...; } & { ...; } & { ...; }) | (Omit<...> & ... 1 more ... & { ...; })): Element', gave the following error.
    Type '"new_account.store"' is not assignable to type '"dashboard" | "home" | "customers.store" | "customers.index" | "admin_auth.login" | "admin_auth.logout" | "admin_auth.me" | "session.create" | "session.store" | "session.destroy" | undefined'.
inertia/pages/auth/signup.tsx(24,38): error TS2339: Property 'fullName' does not exist on type '{ email?: string | undefined; password?: string | undefined; }'.
inertia/pages/auth/signup.tsx(26,23): error TS2339: Property 'fullName' does not exist on type '{ email?: string | undefined; password?: string | undefined; }'.
inertia/pages/auth/signup.tsx(26,74): error TS2339: Property 'fullName' does not exist on type '{ email?: string | undefined; password?: string | undefined; }'.
inertia/pages/auth/signup.tsx(72,38): error TS2339: Property 'passwordConfirmation' does not exist on type '{ email?: string | undefined; password?: string | undefined; }'.
inertia/pages/auth/signup.tsx(74,23): error TS2339: Property 'passwordConfirmation' does not exist on type '{ email?: string | undefined; password?: string | undefined; }'.
inertia/pages/auth/signup.tsx(75,56): error TS2339: Property 'passwordConfirmation' does not exist on type '{ email?: string | undefined; password?: string | undefined; }'.
```

## Causa raiz e investigação

- `start/routes.ts` registra home, session.create/store/destroy, dashboard e APIs. Não registra new_account.create/store. O controller NewAccount existe como resquício, mas nenhum endpoint aponta para ele.
- O registro `.adonisjs/client/registry/schema.d.ts` corresponde às rotas reais: session.store infere o corpo de loginValidator (email/password); não há rota de cadastro. Não é um erro de alias ou registro defasado a corrigir inventando novas rotas/tipos.
- `app/validators/user.ts` já declara fullName e passwordConfirmation no signupValidator. Portanto os seis TS2339 não indicam falta desses campos no validator: o Form usa uma rota inexistente e não consegue selecionar esse corpo. As duas referências de rota e a inferência inválida do formulário foram investigadas separadamente.
- A dependência instalada implementa FormRouteProps por ExtractRouteBody<Route> em `node_modules/@adonisjs/inertia/build/src/client/react/form.d.ts`; o contrato gerado não deve ser alargado para aceitar a página órfã.
- Inertia continua ativo: provider em adonisrc.ts, middleware global em start/kernel.ts, props/flash em InertiaMiddleware, home/login/dashboard por rotas reais e 404/500 no exception handler. Vite compila inertia/app.tsx, que resolve todas as páginas via import.meta.glob. Remover a integração globalmente afetaria execução e erros.
- `tsconfig.json` referencia o projeto composite `tsconfig.inertia.json`; a verificação explícita de inertia/tsconfig.json cobre os aliases ~/ e @generated e os arquivos gerados. As opções estritas herdadas, includes, excludes, referências e scripts não foram alterados.
- Versões instaladas inspecionadas: TypeScript 6.0.3, AdonisJS core 7.6.0, AdonisJS Inertia 5.0.5, Inertia React 3.11.0 e Tuyau core 1.3.0. Nenhuma atualização, instalação, remoção ou mudança de lockfile foi necessária. O shim local não participa da correção.

## Correção aplicada

1. Remover do layout marketing somente o CTA com a rota de cadastro inexistente, mantendo o link real de login e o ramo autenticado do dashboard. Isso também corrige o erro runtime de construção da URL na raiz e nos layouts de erro.
2. Manter `inertia/pages/auth/signup.tsx` na árvore, no índice de páginas, nos assets e no typecheck. Substituir seu formulário sem endpoint por aviso explícito de cadastro indisponível e link tipado para session.create. A página não ganhou rota pública.

A causa foi removida da UI, sem supressões, any novo, casts para esconder erros, exclusões do typecheck ou criação de conta pública. Login, validators, controllers, rotas, autenticação, sessões, CSRF, regras de reserva/calendário e dependências permanecem intactos. O controller/validator legados não foram apagados oportunisticamente nem reativados; eventual limpeza futura é separada.

## Evidências finais

- `npm run typecheck`: **exit 0, zero diagnósticos**, tanto antes quanto depois de gerar índices/build. O comando oficial continua executando os dois tsc.
- `tsc --noEmit --project inertia/tsconfig.json --listFilesOnly` confirmou inclusão de marketing.tsx, auth/signup.tsx, auth/login.tsx e páginas de erro. O manifest real do build também contém o chunk de signup: a página não foi escondida da verificação/compilação.
- **313 testes backend aprovados**: 130 unitários e 183 funcionais, incluindo três novos testes de regressão Inertia; nenhum teste ou asserção anterior removido.
- Novos testes verificam contratos reais de home/login, proteção do dashboard, login/logout administrativo legado com CSRF e impossibilidade de criar contas pelas URLs legadas. O cliente de teste segue a negociação X-Inertia-Version/409 real da biblioteca, em vez de desativar o versionamento na aplicação.
- `npm run lint`: exit 0. `npm run build`: exit 0. Nenhum ignore-ts-errors/continue-on-error.
- **44 E2E reais aprovados**, desktop/mobile, com o frontend existente e E2E_BACKEND_PATH apontando para o worktree corrigido. Nenhuma alteração frontend ou patch de fixture foi utilizado.
- Chrome com **assets compilados e NODE_ENV=production**: home 200 renderiza sem link quebrado; Sign in navega para login 200 com form action=/login; página inexistente renderiza errors/not_found (404); falha SQL deliberada no banco descartável renderiza errors/server_error (500). **Zero pageerrors JavaScript**. A falha foi criada renomeando somente a tabela services do SQLite de `/tmp/lourenco-r08-production-build/tmp/`, nunca do banco original.

Testes e build executados em cópias/SQLite descartáveis, com ambientes sintéticos. Os temporários de testes usam TMPDIR=/dev/shm quando disponível, mantendo timeouts e asserções existentes. A verificação inicial sob sandbox restrito impediu enumerar interfaces/cache do Vite; essa execução incompleta não foi contabilizada como testes aprovados. A execução válida permitiu somente os recursos locais necessários e confirmou o resumo real da suíte além do exit code.

O smoke de produção usa HTTP loopback e não valida TLS/proxy de um deploy. Capturas e logs de execução são artefatos temporários; não contêm dados de clientes reais e não entram no Git. Resultados são relatados pelo Codex a partir de execuções locais, não checks independentes de CI.

## Preservação e riscos residuais

O workspace backend original continua com seu lockfile modificado e `types/` não rastreado, intactos. .env, SQLite original e credenciais não foram carregados nas cópias nem modificados. A main local foi apenas sincronizada por fast-forward no worktree; branches antigas não foram apagadas ou reescritas. O frontend permaneceu sem mudanças de código/configuração, com sua revisão original preservada.

R08 está corrigido nesta proposta, pendente de revisão técnica/merge. Não é declaração de prontidão para produção e não encerra os demais achados. Inertia continua sendo uma superfície ativa a manter; o build sozinho não substitui o typecheck completo. A padronização de erros JSON (R09), automação de CI e infraestrutura continuam separadas. Nenhum merge ou deploy foi realizado.
