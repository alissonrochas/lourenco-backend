# Catálogo público de serviços

`GET /api/services` é público, não requer sessão nem preparação de CSRF. Retorna HTTP 200 com `{ "data": [...] }`; catálogo sem serviços ativos retorna `{ "data": [] }`.

A consulta filtra `isActive = true` no banco e ordena por ID crescente. Desativar um serviço na API administrativa o remove da próxima consulta pública; reativá-lo restaura o mesmo registro. A resposta usa `Cache-Control: no-store` para evitar manter catálogos obsoletos após essas alterações.

O `ServiceTransformer` existente limita a resposta a `id`, `name`, `description`, `priceCents`, `durationMinutes`, `isActive`, `createdAt` e `updatedAt`, em camelCase. Datas seguem a serialização ISO existente; descrição pode ser null. Os timestamps e o status fazem parte do contrato já aprovado. Nenhum dado de usuário, cliente, sessão, reserva ou disponibilidade é incluído. Os endpoints administrativos permanecem protegidos e inalterados.

Exemplo local, com o backend em execução:

```bash
curl -i -H 'Accept: application/json' http://localhost:3333/api/services
```

Não é necessário preparar cookies ou enviar header X-XSRF-TOKEN para esse GET. Os métodos de escrita existentes mantêm o CSRF global.

## Verificação

```bash
npm test -- functional
npm test -- unit
npm run lint
npm run build
```

Os testes usam o SQLite isolado em memória já configurado e aplicam/revertem migrations reais pelo bootstrap, sem acessar o banco de desenvolvimento. A nova suíte cobre visitante, administrador, catálogo vazio ou só com inativos, filtro de ativos, ordenação, transformer, privacidade, desativação/reativação pela API administrativa e preservação dos contratos administrativos. A suíte anterior continua sendo executada integralmente.

O planejamento para blocos fixos de 60 minutos e gestão futura do calendário está em [booking-mvp-plan.md](booking-mvp-plan.md). Não há implementação de agenda nesta etapa, e a duração de um serviço não implica disponibilidade de horários.
