# API administrativa de exceções de calendário

Esta etapa acrescenta bloqueios por data inteira e por bloco de hora de uma data, sem alterar o funcionamento semanal. Mantém a agenda única, um barbeiro, blocos de 60 minutos e fuso `America/Sao_Paulo`, conforme [booking-mvp-plan.md](booking-mvp-plan.md), [booking-schedule-model.md](booking-schedule-model.md) e [admin-booking-settings-api.md](admin-booking-settings-api.md).

## Persistência

| Tabela/model | Chave de negócio | Campos |
| --- | --- | --- |
| `date_blocks` / `DateBlock` | `local_date` UNIQUE | id, local_date, is_blocked, reason, created_at, updated_at |
| `date_slot_blocks` / `DateSlotBlock` | `(local_date, starts_at_minute)` UNIQUE | Os mesmos campos e starts_at_minute |

A migration `1795737600000_create_calendar_exception_tables.ts` cria somente essas duas tabelas, sem seeds nem alterações nas anteriores. O down remove as duas tabelas novas e seus dados. Não há FK para dias semanais: as exceções sobrevivem a mudanças do funcionamento e podem ser cadastradas mesmo em datas atualmente fechadas ou sem configuração.

- PKs inteiras e índices únicos impedem duplicatas. Os índices iniciados pela data também atendem consultas por período e ordenação.
- Datas são strings canônicas YYYY-MM-DD, não timestamps nem colunas Lucid dateTime. Aceitam anos 0001–9999 e dias reais do calendário gregoriano, incluindo a regra de séculos bissextos.
- Validação de aplicação independente verifica componentes e quantidade de dias de cada mês; hooks beforeSave aplicam essa regra também aos models. CHECKs de formato/calendário protegem ainda SQL direto, sem depender da normalização de funções date() do SQLite.
- O início do horário é inteiro 0–1380, múltiplo de 60. 00:00 é 0 e 23:00 é 1380; 24:00 não é início válido. O fim implícito é início + 60, sempre dentro do dia.
- Status obrigatório com domínio SQLite 0/1, default true; consumo pelo model produz booleano JavaScript.
- Motivo opcional, até 500 caracteres após trim, string ou null. String vazia/com espaços vira null. Motivo omitido preserva o anterior; no registro novo fica null. O banco também limita o tamanho armazenado. Tipos estritos de entrada são responsabilidade de VineJS; afinidade SQLite não substitui essa validação.
- Timestamps seguem o padrão Lucid atual: createdAt automático e preservado, updatedAt atualizado apenas em mudanças persistidas. Não há DELETE ao liberar.

## Datas locais, sem conversão de instantes

`localDate` identifica o dia no calendário da barbearia. A aplicação não usa new Date(), conversão UTC nem parsing de timestamps para esses campos. A aritmética do limite de consulta usa ordinais gregorianos inteiros, evitando dias de 23/25 horas e deslocamentos de fuso.

`2028-02-29` e `2000-02-29` são válidas; `2026-02-29`, `1900-02-29`, `2026-04-31`, datas sem zero à esquerda e strings com sufixo de horário são inválidas. Uma data como `2018-11-04` continua sendo esse mesmo dia, independentemente de transições históricas de horário de verão. Datas passadas são permitidas nesta configuração; não há regra de horizonte de reserva implementada.

O body parser existente remove espaços externos de strings JSON antes da validação. Isso foi preservado, sem alterar configurações globais: o calendário é validado após essa normalização e armazenado de forma canônica. A consulta GET exige parâmetros de data válidos sem usar conversões de timestamp.

## Endpoints e segurança

Somente:

- `GET /api/admin/calendar-exceptions?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /api/admin/calendar-exceptions`

Não há PATCH por ID: IDs de tabelas distintas podem coincidir e não serão usados para endereçamento ambíguo. O POST idempotente usa as chaves de negócio de data e horário. IDs e timestamps são apenas de leitura, separados nos arrays de resposta.

As duas rotas usam o grupo `adminAuth` existente, exigindo sessão e papel administrativo atual. POST mantém CSRF global; GET não exige XSRF. Nenhum endpoint público novo ou mecanismo de autenticação foi criado. O frontend futuro deverá manter credentials: include e preparar CSRF no POST.

As respostas do controller são JSON com Cache-Control: no-store, incluindo 422 e 409. Autenticação e CSRF usam os handlers atuais. Reason é informação administrativa: está presente somente nesse contrato protegido; futuras APIs públicas devem usar serializers próprios e nunca publicar motivos ou detalhes de reservas.

## GET por período

from e to são obrigatórios, com datas reais, from <= to e no máximo **93 dias inclusivos**. Intervalos de um dia são aceitos. Parâmetros desconhecidos são rejeitados. O limite é de consulta, não de antecedência de reserva nem de funcionamento.

Retorna somente registros existentes no período, incluindo bloqueios liberados, sem gerar dias artificiais ou inserir registros. As duas leituras ocorrem na mesma transação de leitura. dateBlocks ordena por localDate; slotBlocks por localDate e startsAtMinute.

Exemplo: `GET /api/admin/calendar-exceptions?from=2026-12-25&to=2026-12-25`

```json
{
  "data": {
    "dateBlocks": [
      {
        "id": 1,
        "localDate": "2026-12-25",
        "isBlocked": true,
        "reason": "Feriado",
        "createdAt": "2026-11-25T12:00:00.000+00:00",
        "updatedAt": "2026-11-25T12:00:00.000+00:00"
      }
    ],
    "slotBlocks": [
      {
        "id": 1,
        "localDate": "2026-12-25",
        "startsAtMinute": 600,
        "isBlocked": false,
        "reason": null,
        "createdAt": "2026-11-25T12:00:00.000+00:00",
        "updatedAt": "2026-11-25T12:00:00.000+00:00"
      }
    ]
  }
}
```

Timestamps de auditoria são instantes ISO da serialização atual; isso não converte localDate para UTC. IDs/timestamps do exemplo são ilustrativos. Sem registros, a resposta é `{ "data": { "dateBlocks": [], "slotBlocks": [] } }`.

## POST idempotente por data e horário

Bloquear a data inteira e dois horários numa única operação:

```json
{
  "localDate": "2026-12-25",
  "dayBlock": { "isBlocked": true, "reason": "Feriado" },
  "slotBlocks": [
    { "startsAtMinute": 840, "isBlocked": true, "reason": "Compromisso" },
    { "startsAtMinute": 960, "isBlocked": true }
  ]
}
```

Retorna HTTP **200**, tanto ao criar quanto ao atualizar, com o mesmo envelope do GET contendo todos os registros dessa data. Cada item informa isBlocked booleano obrigatório e motivo opcional; slots também exigem startsAtMinute. Até 24 slots, sem início duplicado no payload, inclusive quando os status forem diferentes.

- localDate é obrigatória; deve haver dayBlock ou pelo menos um slot. Payload vazio, só data ou só lista vazia recebe 422.
- dayBlock omitido preserva o registro de data inteira.
- slotBlocks omitido ou vazio não modifica horários. Uma lista enviada **altera somente os slots explícitos**, preservando os omitidos. Diferentemente do contrato semanal, não é uma lista de substituição do conjunto.
- Repetir a mesma data/horário atualiza o registro existente, preservando ID e createdAt. Requisição idêntica não gera duplicata nem força updatedAt. O mesmo horário pode existir em datas diferentes.
- Motivo omitido preserva o anterior. Para removê-lo, envie null ou texto vazio. Para atualizar somente o motivo, envie também o status desejado do item.
- Não há exclusão física nem reinterpretação automática de flags omitidas.

Liberar somente 14:00 da mesma data, preservando 16:00 e o bloqueio de dia inteiro:

```json
{
  "localDate": "2026-12-25",
  "slotBlocks": [{ "startsAtMinute": 840, "isBlocked": false }]
}
```

Liberar apenas o bloqueio do dia, mantendo os slots e o motivo anteriores:

```json
{
  "localDate": "2026-12-25",
  "dayBlock": { "isBlocked": false }
}
```

Uma liberação inicial também cria um registro inativo da respectiva chave, que poderá ser reativado posteriormente. Nenhuma dessas operações abre horários por si só.

## Precedência e futura disponibilidade

Fechamentos prevalecem. A futura disponibilidade deverá excluir um bloco se houver qualquer condição impeditiva: dia semanal fechado/não configurado, intervalo semanal ativo, bloqueio semanal, bloqueio da data inteira, bloqueio específico da data ou reserva confirmada.

`isBlocked: false` significa somente ausência daquele impedimento; **nunca é uma autorização de abertura**. Liberar um slot não desfaz um dateBlock ativo. Liberar o dia inteiro não libera slots específicos nem modifica dias, pausas ou bloqueios semanais. A resposta administrativa mostra as flags persistidas, não um cálculo de disponibilidade efetiva.

Exceções podem ser armazenadas para dias atualmente fechados e fora do funcionamento semanal, pois continuam fazendo sentido se a configuração mudar. Não há consulta/validação de abertura semanal ao gravá-las. A futura API de disponibilidade é responsável por combinar todas as regras, interpretar instantes em America/Sao_Paulo e não divulgar motivos administrativos ou dados pessoais. Nada disso cria reservas nesta PR.

## Validação e erros

VineJS valida exclusivamente o corpo POST ou os parâmetros GET, sem incluir automaticamente metadados de headers/cookies/params do framework. A whitelist rejeita campos desconhecidos em todos os níveis, incluindo IDs, timestamps, chaves de usuários/clientes, timezone e nomes snake_case. Não há mass assignment. Números e booleanos são estritos; null só é aceito em reason, não em status, listas ou objetos.

| Status | Situação |
| --- | --- |
| 200 | Leitura/criação/atualização válida, envelope data |
| 401 | Sessão ausente, handler adminAuth existente |
| 403 | Papel revogado ou CSRF ausente/inválido, handlers existentes |
| 422 | Entrada, data, horário ou intervalo inválido: `{ "message": "Exceção ou intervalo de calendário inválido." }` |
| 409 | Contenção/integridade: `{ "message": "Conflito na configuração do calendário. Recarregue e tente novamente." }` |

Erros tratados não incluem SQL, mensagens de constraints, motivos privados do banco ou stack traces; Accept HTML não altera esses retornos para páginas.

## Transações e concorrência

Um POST salva todos os itens e relê a resposta numa única transação Lucid. Falha em qualquer item reverte também a data inteira e os horários anteriores da operação. Não há escrita fora dessa transação.

A primeira instrução é o mesmo UPDATE sem mudança de valor em booking_settings usado pelo serviço semanal. Adquire a trava SQLite de escrita antes de consultar registros, mesmo com singleton ausente; não cria a configuração global nem altera seus valores/timestamps. Assim, configurações semanais e exceções seguem a mesma estratégia de serialização no banco, sem mutex em memória. Índices UNIQUE continuam impedindo duplicatas no armazenamento.

Outro escritor aguarda o timeout do driver ou resulta em 409 controlado. Não há retry automático nem versionamento otimista: escritas válidas da mesma chave são aplicadas sequencialmente; a última define os campos que enviou. Em 409, recarregar/reconciliar antes de repetir. Slots omitidos preservam gravações anteriores de outras operações.

**Antes de habilitar reservas públicas**, será obrigatória a verificação de conflitos com reservas confirmadas após adquirir essa trava e antes de salvar qualquer bloqueio, dentro da mesma transação. O serviço marca esse ponto de integração, sem consultar tabelas inexistentes ou simular uma verificação agora. Alterações de bloqueio e reservas deverão compartilhar essa estratégia; nunca cancelar ou mover reservas silenciosamente.

## Verificação e limites

```bash
npm test -- unit
npm test -- functional
npm run lint
npm run build
```

Testes de API usam o SQLite isolado em memória. Testes de migration/model usam um arquivo SQLite temporário com MigrationRunner real, verificando aplicação, rollback, reaplicação e preservação de todas as oito tabelas anteriores e suas fixtures. O teste de contenção usa duas conexões independentes ao mesmo arquivo. A validação completa roda em cópia descartável do backend; não executar migrations no banco de desenvolvimento como parte desse processo.

A cobertura inclui sessão, revogação de papel, CSRF, bloqueio/liberação, múltiplos slots/datas, idempotência e timestamps, datas inválidas/bissextos, limites de horário, campos extras, motivos privados, JSON/no-store, filtro e limite de período, ordem, rollback e concorrência. As APIs anteriores continuam na suíte de regressão.

Sem frontend, tabelas de reservas, agendamentos, disponibilidade pública, bloqueios de múltiplos profissionais, autenticação de clientes, notificações ou dependências novas.
