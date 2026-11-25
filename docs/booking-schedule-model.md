# Persistência do funcionamento da barbearia

Esta etapa implementa apenas quatro tabelas e seus models Lucid, conforme [booking-mvp-plan.md](booking-mvp-plan.md). Não há endpoints de configuração, geração de disponibilidade, reservas, bloqueios por data ou frontend novo.

## Regras fixas do MVP

Uma agenda para um barbeiro, clientes sem contas e blocos futuros de 60 minutos iniciados em horas cheias. O fuso é `America/Sao_Paulo`. A duração dos serviços permanece independente desses blocos. Abertura e fechamento não são constantes do código: serão configurados pelo administrador no banco através da futura API.

Timezone e duração do bloco estão protegidos por CHECKs, inclusive contra gravações diretas ou pelo model. Modificá-los exigirá uma mudança deliberada nas regras e uma nova migration; uma futura API genérica de configurações não deve permitir alterá-los arbitrariamente.

## Tabelas e models

| Tabela | Model | Campos específicos |
| --- | --- | --- |
| `booking_settings` | `BookingSetting` | `id`, `timezone`, `slot_duration_minutes` |
| `weekly_opening_hours` | `WeeklyOpeningHour` | `id`, `weekday`, `is_active`, `opens_at_minute`, `closes_at_minute` |
| `weekly_breaks` | `WeeklyBreak` | `id`, `weekly_opening_hour_id`, `starts_at_minute`, `ends_at_minute`, `is_active` |
| `weekly_slot_blocks` | `WeeklySlotBlock` | `id`, `weekly_opening_hour_id`, `starts_at_minute`, `is_blocked` |

Todas incluem `created_at` obrigatório e `updated_at` nullable, seguindo o padrão atual. Os models usam camelCase e timestamps automáticos do Lucid; booleanos SQLite 0/1 são consumidos como booleanos JavaScript. A criação pelo Lucid também preenche updatedAt, como nos models existentes. Defaults do banco podem ser lidos com refresh após a inserção.

### Configuração global

A chave primária inteira aceita somente `id = 1`, com default 1, impedindo dois registros. `timezone` é obrigatório, default `America/Sao_Paulo`, com CHECK de igualdade. `slot_duration_minutes` é inteiro obrigatório, default 60, com CHECK de igualdade e tipo armazenado.

A migration não insere registros nem inicializa dias. A constraint garante **no máximo um** registro global, não sua existência permanente. Quando necessário, uma etapa futura pode inicializar deterministicamente o registro 1 numa transação, tratando concorrência pela chave única, sem inventar horários. Nesta etapa, por exemplo, `BookingSetting.create({ id: 1 })` seguido de refresh utiliza os defaults do banco. Não há horizonte de reserva, antecedência mínima ou revisão de calendário implementados; esses pontos do plano continuam pendentes de decisão e implementação própria.

### Dias da semana

`weekday` é inteiro ISO 1–7 (segunda a domingo), NOT NULL e UNIQUE. `is_active` é booleano obrigatório, default false: cadastrar um dia sem configuração não abre a barbearia.

Um dia inativo pode ter ambos os horários nulos ou conservar um par válido para futura reativação. Apenas um horário nulo é inválido. Um dia ativo exige um par válido. Sempre que presentes, os horários são inteiros em horas cheias, abertura entre 0 e 1380 e fechamento entre 60 e 1440, com abertura < fechamento. Essa regra vale também para pares preservados de dias inativos, evitando configurações inválidas latentes.

Meia-noite é 0; 09:00 é 540; 12:00 é 720; 18:00 é 1080. O valor 1440 representa exclusivamente o limite de fechamento 24:00 do próprio dia; não é um horário inicial. Não há funcionamento atravessando meia-noite. Para um fechamento às 24:00, o último bloco possível começará às 23:00, quando a disponibilidade for implementada.

### Intervalos recorrentes

Cada `WeeklyOpeningHour` tem muitos `breaks`; cada `WeeklyBreak` pertence a um dia por `weeklyOpeningHourId`. A FK é obrigatória e possui índice para consultas por dia. Início e fim são inteiros alinhados a 60, nos mesmos limites do funcionamento, e início < fim. `is_active` é booleano obrigatório, default true. Desativar a pausa preserva seu registro; pausas inativas também precisam manter um intervalo individual válido.

Múltiplas pausas no mesmo dia são permitidas. Não há constraint de unicidade de pausa nem verificação de sobreposição nesta etapa: a API futura deverá rejeitar duplicatas/sobreposições e garantir que os intervalos caibam no funcionamento, numa transação que revalide as regras relevantes.

### Bloqueios semanais

Cada dia tem muitos `slotBlocks`; cada `WeeklySlotBlock` pertence a um dia pela mesma FK obrigatória. A combinação `(weekly_opening_hour_id, starts_at_minute)` é UNIQUE; esse índice também atende pesquisas por dia. O início é inteiro de 0 a 1380, múltiplo de 60. O término implícito do futuro bloco é início + 60.

`is_blocked` é booleano obrigatório, default true. false libera apenas esse bloqueio: não abre um dia fechado, não ignora pausas, reservas ou futuras exceções por data. Rebloquear/liberar preserva o mesmo registro.

## Integridade no SQLite

- PRIMARY KEY e CHECK de id fixo impedem múltiplas configurações globais.
- CHECKs e NOT NULL fixam timezone e duração do bloco.
- UNIQUE e CHECK garantem dias válidos, sem repetição.
- CHECKs com typeof garantem valores inteiros armazenados, domínio booleano e alinhamento/ordem/limites dos horários. SQLite ainda pode converter valores numericamente equivalentes por afinidade; isso não substitui tipos estritos de entrada na futura API.
- FOREIGN KEYs impedem intervalos ou bloqueios órfãos. ON DELETE RESTRICT e ON UPDATE RESTRICT impedem apagar/trocar a chave do dia com filhos; não há cascata silenciosa.
- A verificação de FKs deve permanecer habilitada por conexão. O better-sqlite3 instalado a habilita por padrão; os testes conferem `PRAGMA foreign_keys = 1` e `foreign_key_check`.
- Índices suportam os acessos por dia e as restrições de unicidade. Não há índices extras sem uso previsto.

CHECKs não validam relações entre linhas e tabelas. Não adicionamos triggers para tentar implementar a futura agenda nesta PR.

## Exemplo de configuração, sem seed

Exemplo conceitual de dados que o administrador poderá configurar posteriormente:

| Entidade | Configuração |
| --- | --- |
| Segunda, weekday 1 | Ativa, abre 540 (09:00), fecha 1080 (18:00) |
| Pausa da segunda | Ativa, 720–780 (12:00–13:00) |
| Outra pausa da segunda | Ativa, 960–1020 (16:00–17:00) |
| Bloqueio da segunda | Início 600 (10:00), isBlocked true |
| Domingo, weekday 7 | Inativo, abertura e fechamento null |

Esse exemplo não é criado pela migration nem define disponibilidade nesta etapa. Um dia sem registro ou inativo deverá ser tratado como fechado pelo cálculo futuro; não presumir horários para preencher lacunas.

## Responsabilidades da futura API administrativa

Reutilizar adminAuth, CSRF para escritas, validação VineJS estrita, whitelist, respostas JSON e no-store. IDs, timestamps, timezone e duração fixa não serão campos livremente editáveis. Validar consistência do conjunto de dias/pausas/bloqueios antes de gravar.

Rejeitar intervalos sobrepostos/duplicados, pausas fora da abertura e bloqueios que não caibam no funcionamento, conforme a política de configuração a ser consolidada. Definir de forma explícita o tratamento de pausas/bloqueios preservados ao desativar ou reativar um dia. Liberar um bloqueio não deve ultrapassar as demais regras do calendário. Não expor dados administrativos ou pessoais na futura disponibilidade pública.

Quando existirem reservas, alterações de funcionamento devem consultar reservas confirmadas afetadas **dentro da mesma proteção transacional** usada para novas reservas. Seguir a proposta do plano: rejeitar com conflito, exigir resolução explícita e auditada, nunca cancelar ou mover silenciosamente. Unicidade de reserva isoladamente não protege contra corrida com bloqueio; testar serialização de gravações SQLite com conexões concorrentes. Não existem tabelas de reservas ou proteção transacional de agenda implementadas nesta etapa.

## Migration e verificação

`1795651200000_create_booking_schedule_tables.ts` é aditiva. Cria primeiro configurações e dias, depois as tabelas filhas. O down remove bloqueios, pausas, dias e configurações nessa ordem. Não altera usuários, clientes, sessões ou serviços. Rollback remove os dados dessas quatro tabelas novas; é uma operação de reversão, não um mecanismo de cancelamento de reservas.

Os testes usam um arquivo SQLite temporário próprio e o MigrationRunner real do Lucid. Aplicam as migrations anteriores, inserem fixtures das tabelas existentes, executam a nova migration como um novo batch e conferem schema/dados antes e depois de aplicação, rollback e reaplicação. Os testes de models usam transações explícitas nessa conexão isolada. Nenhuma migration precisa ser executada no banco de desenvolvimento.

```bash
npm test -- unit
npm test -- functional
npm run lint
npm run build
```

Cobertura: singleton, defaults, fuso/bloco fixos, dias ISO, status, horários e limites, pausas múltiplas, bloqueios únicos, FKs, mapeamento e relações Lucid, timestamps e rollback com preservação das tabelas anteriores. A suíte funcional existente permanece como regressão. Nenhuma dependência nova foi adicionada.
