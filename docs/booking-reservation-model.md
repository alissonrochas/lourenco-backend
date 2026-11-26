# Modelagem e persistência de reservas

> Atualização: existe agora POST /api/bookings; o adapter de disponibilidade desconta confirmed, e alterações de calendário protegem reservas em curso/futuras. Consulte [public-booking-creation-api.md](public-booking-creation-api.md). Consulta e cancelamento administrativos agora seguem [admin-booking-management-api.md](admin-booking-management-api.md). O texto original abaixo registra o escopo da PR de modelagem.

Esta etapa cria somente `bookings` e o model Lucid `Booking`, preparando a futura API de agendamento. Não existem endpoints de criação, cancelamento ou listagem de reservas. Não há seeds, frontend, contas de clientes, pagamentos ou múltiplos barbeiros.

Compatível com [booking-mvp-plan.md](booking-mvp-plan.md), [booking-availability-engine.md](booking-availability-engine.md), [booking-schedule-model.md](booking-schedule-model.md), [admin-booking-settings-api.md](admin-booking-settings-api.md), [admin-calendar-exceptions-api.md](admin-calendar-exceptions-api.md) e [public-booking-availability-api.md](public-booking-availability-api.md).

## Estrutura

| Coluna | Propriedade no model | Regra |
| --- | --- | --- |
| id | id | PK inteira gerada pelo banco |
| customer_id | customerId | FK obrigatória para customers |
| service_id | serviceId | FK obrigatória para services |
| starts_at_utc | startsAtUtc | Inteiro Unix em milissegundos, obrigatório |
| ends_at_utc | endsAtUtc | Mesmo formato, exatamente início + 3.600.000 |
| local_date | localDate | Data gregoriana real YYYY-MM-DD |
| starts_at_minute | startsAtMinute | Inteiro 0–1380, múltiplo de 60 |
| status | status | confirmed ou cancelled, default confirmed |
| service_name_snapshot | serviceNameSnapshot | Nome obrigatório, 2–120 caracteres após trim |
| service_price_cents_snapshot | servicePriceCentsSnapshot | Inteiro 0–Number.MAX_SAFE_INTEGER |
| cancelled_at_utc | cancelledAtUtc | Instante de cancelamento no mesmo formato UTC, nullable |
| cancelled_by_user_id | cancelledByUserId | FK nullable para users, ator administrativo do cancelamento |
| cancellation_reason | cancellationReason | Texto nullable de auditoria, não público |
| created_at | createdAt | Timestamp Lucid obrigatório, autoCreate |
| updated_at | updatedAt | Timestamp Lucid obrigatório, autoCreate/autoUpdate |

Não são duplicados nome ou telefone do cliente. A reserva referencia o Customer existente e não cria uma segunda tabela de pessoas. Relações belongsTo: customer, service e cancelledBy (esta última usa foreignKey explícita).

## Status e histórico

`confirmed` ocupa o horário; `cancelled` não ocupa. Uma reserva cancelada permanece na tabela com o mesmo ID, referências, horários e snapshots. É possível manter várias canceladas no mesmo horário, mas somente uma confirmada por início UTC.

A futura operação administrativa permitirá apenas confirmed → cancelled, mediante sessão, papel admin atual, CSRF, motivo e gravação atômica da auditoria. Uma reserva cancelada não deverá ser reativada: para reservar novamente, criar um novo registro confirmado. Repetir cancelamento deverá ser tratado de modo idempotente, sem sobrescrever a primeira auditoria.

**Não existe operação de cancelamento implementada nesta PR.** Os testes alteram o model/SQL diretamente para verificar integridade e retenção do histórico, não para oferecer uma API administrativa.

Para confirmed, os três campos de auditoria devem ser null. Para cancelled, os três são obrigatórios: instante UTC inteiro, usuário existente e motivo de 1–500 caracteres após trim. A FK comprova existência do ator, não seu papel ou autorização; a futura camada administrativa deverá verificá-los no momento da ação. Não se exige que o ator continue sendo admin para preservar um cancelamento histórico.

As constraints validam o estado de cada linha, não uma máquina de transições entre estados antigos/novos. SQL direto ou um model usado por código confiável pode alterar status se respeitar constraints; a política de transição terminal, idempotência, instante de auditoria e imutabilidade de registros históricos deverá ser aplicada pela futura operação administrativa.

Esta etapa usa auditoria básica na própria reserva. A tabela de eventos prevista como possibilidade no plano permanece para uma etapa posterior, caso seja necessária trilha de múltiplas ações; não foi criada antecipadamente.

## Instantes UTC canônicos

`starts_at_utc`, `ends_at_utc` e `cancelled_at_utc` são **INTEGER Unix milliseconds**, representados por number seguro em JavaScript. Não são texto ISO, segundos Unix ou timestamps SQLite dependentes de parsing. A origem do epoch é UTC e não exige offset armazenado para identificar um instante.

Exemplo: 28/12/2026 às 09:00 em America/Sao_Paulo corresponde a `2026-12-28T12:00:00.000Z`, persistido como `DateTime.fromISO('2026-12-28T12:00:00Z').toMillis()`. O fim é o número do início + 3.600.000.

Esse formato permite CHECK de duração por aritmética inteira exata e um único valor de chave para o mesmo instante. Não depende de igualdade entre textos ISO com offsets/formatações diferentes nem de diferenças de ponto flutuante com julianday. SQLite pode converter texto numérico por afinidade, mas ele resolve para o mesmo inteiro e não evade a unicidade. O model exige numbers inteiros seguros.

Os instantes são limitados ao intervalo técnico dos anos UTC 0001–9999 (-62135596800000 a 253402300799999 ms). Isso não é um horizonte de reservas do produto. A data local também aceita anos 0001–9999; fronteiras fora desse domínio são recusadas. Os timestamps created_at/updated_at continuam seguindo o padrão atual do Lucid, separados dos instantes de negócio.

## Representação local e fuso

localDate e startsAtMinute preservam o horário escolhido na agenda, em **America/Sao_Paulo**. Não são derivados por `new Date('YYYY-MM-DD')` e não usam um offset fixo -03:00.

Antes de salvar, o model valida:

- Data local real com o helper gregoriano existente, incluindo anos bissextos.
- Instantes e minuto local inteiros, com duração exata de 60 minutos.
- Início convertido por Luxon para America/Sao_Paulo corresponde à data e minuto informados, com segundo/milissegundo zero.
- Início e fim possuem fronteiras locais únicas, sem ambiguidade por mudança de fuso.
- O fim representa uma hora local completa após o início, incluindo término 24:00 na próxima data local.

Essa política corresponde à política conservadora do motor: não escolher silenciosamente uma ocorrência de horário ambíguo nem normalizar um horário inexistente. O registro pode ser histórico; o model não impede datas passadas, pois não é o serviço de criação pública.

O hook consulta as regras IANA do runtime, não o funcionamento semanal ou as exceções. Alterações futuras da base IANA podem exigir análise de compatibilidade de registros históricos; nunca reescrever automaticamente seus instantes/snapshots para adaptá-los.

## Garantias do banco

- NOT NULL para referências, instantes, data/minuto locais, status, snapshots e ambos os timestamps de auditoria de criação/atualização.
- CHECKs com typeof para UTC inteiro dentro do domínio, fim posterior ao início e diferença exata de 3.600.000 ms **em todos os status**. Uma reserva cancelada não perde a forma original do bloco.
- CHECKs gregorianos para data local, incluindo bissextos, e início local inteiro/múltiplo de 60 entre 00:00 e 23:00.
- CHECK de status e integridade conjunta da auditoria de cancelamento.
- CHECKs de nome/preço de snapshot.
- FOREIGN KEYs para clientes, serviços e ator do cancelamento, com ON DELETE RESTRICT e ON UPDATE RESTRICT. Não há cascata que apague histórico. FKs devem permanecer habilitadas por conexão; os testes verificam isso.
- Índices nas FKs e em (local_date, status) suportam consultas futuras e validações administrativas.
- Índice **UNIQUE parcial** `bookings_confirmed_start_unique` sobre starts_at_utc, somente WHERE status = 'confirmed'. Ele independe de uma consulta prévia em JavaScript para impedir duas confirmações do mesmo início.

A migration usa `this.defer(...)` para criar o índice parcial depois da criação efetiva da tabela, respeitando a fila do Lucid instalado. O down remove somente bookings e seus índices. Tabelas e registros anteriores permanecem intactos.

## Limites das constraints

SQLite não conhece as regras IANA históricas/futuras de America/Sao_Paulo. Portanto, o banco **não garante sozinho** que starts_at_utc corresponda ao par local_date/starts_at_minute nem resolve fronteiras ambíguas. SQL direto e atualizações por query builder podem contornar o hook; devem ser restritos a código confiável que valide essa correspondência. O índice UTC garante exclusividade do mesmo início canônico, não a correção de metadados locais arbitrários escritos por fora do model.

O banco também não verifica papel administrativo, serviço ativo, nome/preço atuais do catálogo, funcionamento, pausas, bloqueios, horário futuro, política de cancelamento ou proteção de reservas ao alterar calendário. Não há triggers para simular a futura API. Essas garantias não devem ser anunciadas como já implementadas.

## Snapshots e referências

A futura criação deverá copiar o nome e o preço do serviço validado dentro da mesma transação, enviando explicitamente os campos ao model. Não permitir que o cliente forneça snapshots, preços ou status livremente. Não buscar o nome/preço atual para representar reservas antigas.

Editar ou desativar um Service não altera o snapshot já persistido nem remove reservas. O model não consulta o catálogo automaticamente; a FK assegura apenas referência existente. Validar serviço ativo é obrigação da futura criação, não uma constraint permanente que invalidaria reservas quando o serviço for desativado.

RESTRICT também impede apagar o cliente ou o serviço de uma reserva já cancelada e o usuário registrado como ator. Uma futura política de retenção/anonimização deve ser projetada explicitamente, sem habilitar cascatas. Alterações no cadastro do cliente não reescrevem o snapshot do serviço; dados pessoais não foram duplicados na reserva.

## Concorrência e futura API

A unicidade no SQLite impede duas confirmações do mesmo instante, inclusive com dois escritores independentes. Uma segunda operação pode receber SQLITE_BUSY enquanto a primeira escreve; após o commit da primeira, uma tentativa repetida do mesmo início encontra a constraint UNIQUE. A futura API deverá transformar conflitos esperados em HTTP 409 controlado, sem expor SQL ou dados do ocupante. Nenhum handler HTTP de reservas existe agora.

Fluxo futuro obrigatório:

1. Abrir transação de escrita e adquirir a trava SQLite **antes** das leituras relevantes, usando a estratégia já adotada pelos serviços de configuração e exceções.
2. Validar cliente/contato e serviço ativo e obter os snapshots confiáveis.
3. Executar BookingAvailabilityService com esse mesmo cliente transacional e instante de referência controlado.
4. Consultar reservas confirmed e excluir horários ocupados; revalidar o bloco solicitado.
5. Persistir Booking na mesma transação, manter a constraint parcial como última barreira e tratar concorrência/rollback sem gravação parcial.

Antes de habilitar reservas públicas, alterações de funcionamento e bloqueios também deverão consultar reservas confirmed afetadas sob a mesma trava. Rejeitar mudanças conflitantes e exigir resolução explícita/auditada; nunca cancelar ou mover reservas silenciosamente.

## Compatibilidade com o motor e API pública atual

O motor continua calculando apenas elegibilidade do calendário. Seus campos startsAtUtc/endsAtUtc são ISO UTC; a futura camada converte explicitamente esses instantes para milissegundos ao persistir, usando Luxon. localDate e startsAtMinute são mantidos do bloco validado. Não aceitar duração arbitrária: Service.durationMinutes continua independente do bloco fixo de 60 minutos.

**O motor e GET /api/availability ainda não consultam bookings e não excluem reservas confirmadas nesta PR.** Isso é intencional: não há endpoint público capaz de criar reservas. Um teste registra um bloco válido e comprova que o resultado atual do motor permanece igual, deixando explícito o ponto pendente de integração com ocupação. A disponibilidade continua informativa e não garante vaga.

## Testes e execução

```bash
npm test -- unit
npm test -- functional
npm run lint
npm run build
```

O helper de testes cria SQLite temporário próprio, aplica as migrations anteriores pelo MigrationRunner real e insere somente fixtures temporárias. Confere preservação do schema e dados das dez tabelas existentes após aplicação, rollback e reaplicação. O bootstrap da suíte funcional usa SQLite isolado em memória; não executar migrations no banco de desenvolvimento para testar.

Cobertura nova: constraints de tipos/intervalos/datas/status/snapshots/auditoria, relações Lucid, correspondência IANA e transições históricas, FKs sem cascata, snapshots após edição, timestamps, índice parcial e reuso após cancelamento, duas conexões independentes com contenção e conflito de unicidade, além de compatibilidade com o motor e uma fronteira de meia-noite em dia bissexto.

Todas as suítes anteriores, incluindo autenticação, CSRF e consulta pública sem sessão, continuam sendo executadas. Sem dependências novas, seeds ou alterações nos fluxos de cadastro de clientes e gestão de serviços.
