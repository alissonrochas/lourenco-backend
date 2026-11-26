# Consulta e cancelamento administrativos de reservas

Disponíveis somente com sessão e papel administrativo atual, pelo `adminAuth` existente:

- `GET /api/admin/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /api/admin/bookings/:id/cancel`

Não há consulta pública de reservas, cancelamento pelo cliente ou reagendamento. Não foram criadas migrations ou dependências. Reutiliza Booking, Customer, User, o índice parcial de confirmações e a auditoria já persistida na reserva.

## Consulta por data local e paginação

`from` e `to` são obrigatórios, datas gregorianas reais/canônicas YYYY-MM-DD, anos 0001–9999. Intervalo inclusivo com `from <= to`, no máximo **31 dias**. Uma única data usa from = to. A seleção usa localDate persistida, não a data UTC do início: 23:00 de um dia local pode começar no dia UTC seguinte e permanece no dia solicitado.

Parâmetros opcionais:

| Parâmetro | Padrão | Limite |
| --- | --- | --- |
| page | 1 | Inteiro canônico 1–10000 |
| perPage | 50 | Inteiro canônico 1–100 |

Valores vazios, negativos, fracionários, com zeros externos, arrays/objetos, parâmetros desconhecidos ou repetidos são rejeitados com 422, inclusive repetições iguais e chaves percent-encoded equivalentes. Não há filtro implícito de status: retorna confirmed e cancelled. Datas passadas podem ser consultadas para histórico. Página além dos resultados retorna lista vazia com metadados; em lista vazia lastPage é 1.

Ordenação determinística por startsAtUtc e depois ID, ambos crescentes. Count, página e preload de clientes usam a mesma transação de leitura/snapshot. São até três SELECTs por página: contagem, reservas e clientes por lote, sem N+1. A leitura não adquire a trava de escrita nem cria registros.

Exemplo ilustrativo:

```json
{
  "data": [
    {
      "id": 123,
      "customer": { "name": "Cliente Exemplo", "phone": "71999999999" },
      "serviceName": "Corte",
      "priceCents": 4500,
      "localDate": "2026-12-28",
      "startsAtMinute": 540,
      "startsAtLocal": "2026-12-28T09:00:00.000-03:00",
      "endsAtLocal": "2026-12-28T10:00:00.000-03:00",
      "timezone": "America/Sao_Paulo",
      "slotDurationMinutes": 60,
      "status": "confirmed",
      "cancellation": null
    }
  ],
  "meta": { "page": 1, "perPage": 50, "total": 1, "lastPage": 1 }
}
```

Nome e preço do serviço vêm dos snapshots históricos, mesmo após edição/desativação do catálogo. Contato vem do relacionamento Customer atual: não foi introduzido snapshot de dados pessoais. O transformer administrativo permite explicitamente esses campos; não retorna phoneNormalized, senha, sessão, tokens, dados completos de usuários ou outros campos dos models. Não carrega o catálogo atual para reconstruir o histórico.

## Cancelamento e política temporal

Preparar CSRF pela API existente, conservar cookies com `credentials: 'include'` e enviar o token em `X-XSRF-TOKEN`.

```http
POST /api/admin/bookings/123/cancel
Content-Type: application/json
```

```json
{ "reason": "Cancelamento solicitado pelo cliente" }
```

O ID da rota deve ser inteiro positivo canônico e seguro em JavaScript; inválido recebe 422 e um ID válido inexistente recebe 404. Reason é obrigatório, string com 1–500 caracteres após trim. Vazio, null, tipos incorretos e campos desconhecidos recebem 422. Valida-se somente o corpo, sem incluir query ou metadados. Não se aceita ator, status, preço, referências, instantes ou timestamps do cliente. O body parser e sua normalização permanecem os existentes; assim como nas demais escritas, não há detector adicional de chaves JSON repetidas.

**Política conservadora:** somente confirmed com `startsAtUtc > now` pode ser cancelada. Reserva começando exatamente agora, em curso ou já encerrada recebe 409 sem alteração. Não existe correção retroativa de histórico nesta etapa.

Resposta 200 com `{ "data": {...} }`, usando as mesmas propriedades de um item da consulta, status cancelled e:

```json
{
  "cancellation": {
    "cancelledAtUtc": 1796126400000,
    "cancelledByUserId": 7,
    "reason": "Cancelamento solicitado pelo cliente"
  }
}
```

O fragmento mostra apenas o campo de auditoria. cancelledAtUtc é Unix milliseconds UTC, coerente com o model; horários locais da reserva incluem offset e timezone America/Sao_Paulo, sem presumir offset permanente. O ator vem da sessão e é revalidado no banco sob a trava de escrita. Não se carrega nem publica o cadastro completo desse administrador.

### Repetição idempotente

Cancelar novamente uma reserva já cancelled retorna 200 e a primeira auditoria, mesmo depois de o horário original ter passado. Exige sessão/papel atual, CSRF e motivo válido novamente; o novo motivo é ignorado. Não executa save, não altera updatedAt nem troca ator, instante ou motivo. Não reativa o registro. Um novo agendamento é outra reserva, com outro ID e snapshots próprios.

ID, cliente, serviço, início/fim, data/minuto local, snapshots e createdAt são preservados. Lucid atualiza updatedAt no primeiro cancelamento; o cliente não é modificado. Nenhuma reserva é excluída fisicamente. As FKs RESTRICT continuam preservando referências inclusive de registros cancelados.

## Transação e concorrência

AdminBookingService abre uma transação Lucid. A primeira instrução é o UPDATE sem mudança de valor de booking_settings, inclusive quando o singleton está ausente. Obtém a trava SQLite de escrita **antes** de consultar administrador/reserva, sem criar configurações ou mudar seus timestamps.

Dentro desse mesmo cliente transacional:

1. Revalida que o ator autenticado ainda existe e tem papel admin.
2. Carrega a reserva e o contato por preload limitado.
3. Verifica status; se cancelled, retorna o histórico original.
4. Captura o relógio do servidor após a trava e verifica que a reserva ainda não começou.
5. Grava somente status e os três campos de auditoria, pelo Lucid.
6. Faz commit; qualquer falha reverte a alteração inteira.

É a mesma estratégia de serialização usada pela criação pública e pelos escritores de calendário. Outro escritor aguarda o timeout do driver ou recebe erro controlado; não existe retry automático nem mutex em memória.

Após commit de cancelamento, o índice UNIQUE parcial libera aquele início UTC. Uma nova criação revalida calendário/tempo sob sua própria trava antes de confirmar. Antes do commit, outro escritor não pode ocupar o slot nem sobrescrever auditoria. Duas conexões independentes verificam contenção entre cancelamento, repetição e criação; após liberação, há no máximo uma confirmação do mesmo início e o cancelamento anterior continua armazenado.

A listagem mantém consistência dentro de cada página. Como usa paginação por offset, alterações entre requisições de páginas distintas podem deslocar resultados; recarregar o período após mudanças. Não há snapshot ou cursor persistente entre chamadas HTTP.

## Disponibilidade e proteção de calendário

O motor e os contratos públicos não foram alterados. Confirmed retira o slot; cancelled não o retira. Cancelar não muda abertura, pausas, bloqueios ou o relógio. O horário só reaparece se continuar elegível, sem impedimentos e estritamente futuro. A resposta pública não informa identidade, status, motivo, ator ou detalhes da reserva cancelada.

GET /api/availability continua sem inicializar/persistir sessão, com os mesmos headers, limite por IP e exceção restrita ao GET daquela rota. Não se adicionou qualquer exceção de CSRF. Rotas administrativas mantêm o fluxo original de sessão, Shield e autenticação; o cancelamento exige CSRF global.

As proteções de calendário contra reservas confirmed em curso/futuras permanecem intactas. Após cancelar uma reserva futura, um bloqueio poderá ser salvo se não atingir outra confirmação. Não há movimento ou cancelamento implícito pelo calendário.

## Erros e privacidade

Respostas do controller usam JSON e `Cache-Control: no-store`, inclusive com Accept HTML. Autenticação e CSRF preservam os middlewares/handlers existentes. Erros não incluem SQL, stack, contato ou motivo. Logs inesperados são genéricos, sem erro do driver ou bindings.

| HTTP | Situação |
| --- | --- |
| 200 | Consulta ou cancelamento, inclusive repetição válida |
| 401 | Sem sessão, middleware existente |
| 403 | Papel inadequado/revogado ou CSRF inválido; revalidação do ator também pode negar escrita |
| 404 | ID válido de reserva inexistente |
| 409 | Reserva confirmada já iniciada ou conflito SQLITE_CONSTRAINT* |
| 422 | Query, ID, motivo ou campos desconhecidos inválidos |
| 503 | SQLITE_BUSY*, SQLITE_LOCKED* ou aquisição de conexão indisponível reconhecida |
| 500 | Erro inesperado com mensagem pública genérica |

Erros de constraints provocam rollback e conflito genérico, nunca anúncio de sucesso. Não há consulta por telefone, cancelamento público nem confiança em ID administrativo enviado no corpo. As proteções e orçamentos de rate limiting das APIs públicas permanecem independentes. Limites em memória por processo e configuração correta de TRUST_PROXY continuam conforme a documentação dessas APIs.

## Testes e limites

```bash
npm test -- unit
npm test -- functional
npm run lint
npm run build
```

Usar exclusivamente o SQLite isolado: bootstrap recusa banco diferente de :memory:; testes de transação/concorrência usam arquivo temporário e migrations reais. As verificações desta etapa rodam em cópia descartável, sem .env ou banco de desenvolvimento.

Cobertura: consulta de ambos os status, intervalos reais/bissextos/limites, parâmetros ambíguos, ordenação e paginação, fronteira local/UTC, três SELECTs sem N+1, snapshot consistente com escritor independente, contato administrativo e snapshots históricos, sessão/papel/CSRF, validações de ID/motivo/whitelist, primeira auditoria e repetição com outro admin, passado/início exato/em curso, falha real com rollback, duas conexões concorrentes, nova reserva após cancelamento, FKs, disponibilidade/privacidade e proteção de calendário. Todas as suítes anteriores permanecem como regressão.

Limitações: apenas reservas não iniciadas podem ser canceladas; não há correção histórica, reagendamento, cancelamento público, notificações ou interface. Auditoria básica permanece na própria reserva, sem tabela nova de eventos. Contato atual do cliente não é um snapshot histórico. Grandes volumes podem exigir evolução da paginação/índices; esta etapa limita intervalo, tamanho e número de página sem alterar schema.
