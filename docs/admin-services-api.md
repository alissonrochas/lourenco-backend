# API administrativa de serviços

A API permite listar, consultar, cadastrar e atualizar parcialmente serviços, incluindo ativação e desativação. Não há exclusão definitiva, PUT, endpoint público de serviços, agendamentos ou mudanças no frontend.

## Endpoints

Todos usam o middleware `adminAuth` existente e os cookies de sessão já utilizados por `/api/admin/login`, `/api/admin/logout` e `/api/admin/me`.

| Método | Caminho | Resposta |
| --- | --- | --- |
| GET | `/api/admin/services` | 200, `{ "data": [...] }`, todos os ativos e inativos em ordem crescente de ID |
| GET | `/api/admin/services/:id` | 200, `{ "data": {...} }`; 404 JSON se o ID não for um inteiro positivo seguro ou o serviço não existir |
| POST | `/api/admin/services` | 201, `{ "data": {...} }`, após validar e persistir |
| PATCH | `/api/admin/services/:id` | 200, `{ "data": {...} }`, após atualizar os campos enviados; 404 JSON para ID inválido ou ausente |

Uma listagem vazia retorna `{ "data": [] }`. Consultas não precisam de header CSRF. POST e PATCH mantêm a proteção global de CSRF, sem exceções novas.

## Entrada do cadastro

```json
{
  "name": "Corte com tesoura",
  "description": "Acabamento incluído",
  "priceCents": 4500,
  "durationMinutes": 45,
  "isActive": true
}
```

- `name`: string obrigatória, 2–120 caracteres após remover espaços externos.
- `description`: opcional, aceita `null`, até 1.000 caracteres após trim; vazia, com apenas espaços ou omitida vira `null`.
- `priceCents`: número JSON inteiro, entre zero e `Number.MAX_SAFE_INTEGER`.
- `durationMinutes`: número JSON inteiro entre 5 e 480, inclusive.
- `isActive`: booleano JSON opcional; quando omitido, usa `true`. `false` é preservado. `null`, números e representações textuais não são aceitos.

Os validators VineJS usam números e booleanos estritos. Valores como `"4500"`, `"30"` e `"false"` não são convertidos silenciosamente. As restrições já existentes no SQLite permanecem como segunda camada de integridade.

Somente os cinco campos de negócio são atribuídos explicitamente ao model. Campos adicionais são ignorados: `id`, `createdAt`, `updatedAt`, nomes de colunas em snake_case, campos de usuários e quaisquer outros dados não podem alterar o registro criado nem registros anteriores. Os timestamps e o ID continuam sendo gerados pelo sistema.

## Atualização parcial

O PATCH usa um validator específico, mantendo os padrões do cadastro inalterados. Os cinco campos de negócio seguem os mesmos tipos estritos e limites; somente os enviados são atualizados. Nenhum padrão do cadastro é aplicado aos campos omitidos.

```json
{
  "description": null,
  "priceCents": 5000,
  "isActive": false
}
```

Esse exemplo remove a descrição, altera o preço e desativa o serviço, preservando nome e duração. `isActive: true` reativa o mesmo registro. Descrições vazias ou contendo apenas espaços também viram `null`.

`name`, `priceCents`, `durationMinutes` e `isActive` não aceitam `null`; o validator verifica isso explicitamente porque campos opcionais no Vine instalado também ignoram `null`. PATCH vazio ou contendo apenas campos não editáveis recebe 422 JSON. Um campo válido acompanhado de outro inválido não causa atualização parcial dos dados.

Campos extras são ignorados quando há campos editáveis válidos, mas nunca são atribuídos ao model. `id` e `createdAt` são preservados; `updatedAt` é administrado pelo Lucid ao salvar alterações. A resposta é relida do banco e usa o mesmo transformer do cadastro. O PATCH não cria nem exclui serviços. Seus retornos 200, 404 e 422 usam `Cache-Control: no-store`; autenticação e CSRF continuam nos middlewares existentes.

## Respostas

O `ServiceTransformer` permite somente `id`, `name`, `description`, `priceCents`, `durationMinutes`, `isActive`, `createdAt` e `updatedAt`. A serialização reutiliza o provider existente, com envelope `data`. Datas são ISO 8601, preço/duração são números e status é booleano. Nenhum dado de cliente ou usuário é incluído.

O registro criado é relido antes da resposta, para refletir os valores persistidos, consumo booleano e precisão dos timestamps no SQLite. As respostas bem-sucedidas usam `Cache-Control: no-store`.

Erros de validação usam 422 JSON com `message` e `errors`. Serviço ausente/ID inválido usa 404 JSON com `message`. Esses retornos não dependem de páginas Inertia nem do header Accept. Ausência de sessão e falta de permissão continuam sendo tratadas por `adminAuth` (401/403); CSRF inválido continua usando o handler existente (403 com `E_BAD_CSRF_TOKEN`). A camada que recusar primeiro a requisição determina o erro: os testes de autenticação no POST e PATCH fornecem CSRF válido para testar especificamente a autorização.

Nenhum contrato das APIs anteriores foi alterado.

## Testes isolados

No ambiente de teste (`app.inTest`), a conexão SQLite padrão usa `:memory:`. Desenvolvimento e produção continuam usando o caminho de banco anterior. O bootstrap verifica essa configuração antes de executar as migrations reais por `testUtils.db().migrate()`, com geração de schema desativada pelo utilitário instalado. Não é necessário rodar `node ace migration:run` no banco de desenvolvimento para testar.

Os testes usam a porta escolhida pelo assembler e o HOST configurado, evitando enviar requisições por engano a um servidor de desenvolvimento na porta 3333. O teste funcional anterior foi ajustado somente para compartilhar essa URL dinâmica; seus cenários e expectativas permanecem iguais.

```bash
npm test -- functional
npm test -- unit
npm run lint
npm run build
```

A cobertura inclui administrador, visitante, sessão cujo papel foi revogado, criação válida, limites de campos, tipos inválidos, descrição normalizada, serviço inexistente, ativos/inativos, ordenação, whitelist de entrada/saída, CSRF e consistência JSON. Os testes do PATCH também cobrem preservação de campos omitidos e de registros, ativação/reativação, remoção de descrição, null explícito, payload vazio, timestamps do Lucid, erros JSON com Accept HTML e ausência de mass assignment. O login dos testes usa o endpoint real; não existe implementação paralela de autenticação. Os testes de migration/model anteriores continuam usando SQLite temporário próprio.

Na validação desta etapa, a suíte completa também é executada numa cópia descartável do backend e os hashes do banco real, ambientes, lockfile local e tipos locais são conferidos. Não há novas dependências nem alterações nas migrations.
